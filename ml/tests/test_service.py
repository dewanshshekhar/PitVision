"""Tests for the sidecar's HTTP contract.

Runs a real server against the fixture model on a real socket. What matters
here is the contract the browser depends on: the shape of a corridor response,
that a refusal is a 200 with a null corridor rather than an error, and that a
bad request cannot take the process down — a sidecar that dies on one malformed
frame takes the road detection with it for the rest of the session.

    .venv/bin/python ml/tests/test_service.py
"""

from __future__ import annotations

import base64
import json
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from make_fixture_model import build as build_fixture
from pitvision_ml.config import CorridorConfig, ModelSpec
from pitvision_ml.segmenter import RoadSegmenter
from pitvision_ml.service import Handler, Stats, decode_frame

_passed = 0
_failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global _passed, _failed
    if ok:
        _passed += 1
        print(f"  \033[32m✓\033[0m {name}")
    else:
        _failed += 1
        print(f"  \033[31m✗\033[0m {name}" + (f" — {detail}" if detail else ""))


def section(t: str) -> None:
    print(f"\n\033[1m{t}\033[0m")


def scene(w: int = 768, h: int = 432, *, empty: bool = False) -> np.ndarray:
    frame = np.zeros((h, w, 3), dtype=np.uint8)
    if empty:
        frame[:] = (44, 104, 58)  # all grass
        return frame
    frame[: int(0.36 * h)] = (225, 165, 120)
    for y in range(int(0.36 * h), h):
        t = (y / h - 0.36) / 0.64
        half = 0.08 + 0.30 * t
        l, r = int((0.5 - half) * w), int((0.5 + half) * w)
        frame[y, :l] = (44, 104, 58)
        frame[y, r:] = (44, 104, 58)
        frame[y, l:r] = (118, 118, 119)
    return frame


def as_data_url(frame: np.ndarray) -> str:
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
    assert ok
    return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()


def post(url: str, payload: dict | str, timeout: float = 20.0):
    data = (payload if isinstance(payload, str) else json.dumps(payload)).encode()
    req = urllib.request.Request(url, data=data, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as err:
        body = err.read()
        try:
            return err.code, json.loads(body)
        except json.JSONDecodeError:
            return err.code, {"raw": body[:200].decode(errors="replace")}


FIXTURE_SPEC = ModelSpec("fixture", "_fixture.onnx", "yolop", (384, 640), "local", "test")

with tempfile.TemporaryDirectory() as tmp:
    model_path = Path(tmp) / "_fixture.onnx"
    build_fixture(model_path)

    Handler.segmenter = RoadSegmenter(model_path, FIXTURE_SPEC)
    Handler.segmenter.warm_up(1)
    Handler.corridor_cfg = CorridorConfig()
    Handler.stats = Stats()
    Handler.model_name = "fixture"

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    port = server.server_address[1]
    base = f"http://127.0.0.1:{port}"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    time.sleep(0.2)

    try:
        # ── Decoding ───────────────────────────────────────────────────
        section("Frame decoding")
        frame = scene()
        check("a data: URL decodes to the original size",
              decode_frame(as_data_url(frame).encode()).shape[:2] == frame.shape[:2])
        ok, buf = cv2.imencode(".jpg", frame)
        check("bare base64 without the data: prefix also decodes",
              decode_frame(base64.b64encode(buf.tobytes())).shape[:2] == frame.shape[:2])
        try:
            decode_frame(b"not-an-image")
            check("garbage raises", False)
        except ValueError:
            check("garbage raises a ValueError, not a crash", True)

        # ── Health ─────────────────────────────────────────────────────
        section("Health")
        with urllib.request.urlopen(f"{base}/health", timeout=10) as res:
            health = json.loads(res.read())
        check("health reports ok", health.get("ok") is True)
        check("health names the model and input size",
              health.get("model") == "fixture" and health.get("inputSize") == [384, 640])
        check("health confirms the model was warmed", health.get("warmed") is True)

        # ── The corridor contract ──────────────────────────────────────
        section("A frame with road returns a corridor")
        status, body = post(f"{base}/segment", {"image": as_data_url(frame)})
        check("responds 200", status == 200, str(status))
        corr = body.get("corridor")
        check("a corridor is returned", corr is not None, json.dumps(body)[:160])
        if corr:
            check("it carries the keys the browser reads",
                  set(corr) >= {"yTop", "yBot", "left", "right", "confidence", "meanWidth"})
            check("48 rows each side", len(corr["left"]) == 48 and len(corr["right"]) == 48)
            check("coordinates are normalised", all(0 <= v <= 1 for v in corr["left"] + corr["right"]))
            check("left never crosses right", all(l <= r for l, r in zip(corr["left"], corr["right"])))
            check("it says where the track limits came from",
                  corr.get("limitsFrom") in ("lane_markings", "mask_edge"), str(corr.get("limitsFrom")))
        check("timing is reported so the caller can pace itself",
              body.get("timing", {}).get("inferenceMs", 0) > 0, json.dumps(body.get("timing")))

        # ── Refusal ────────────────────────────────────────────────────
        section("A frame with no road refuses, and says so")
        status, body = post(f"{base}/segment", {"image": as_data_url(scene(empty=True))})
        check("a refusal is a 200, not an error", status == 200, str(status))
        check("the corridor is explicitly null", body.get("corridor") is None)
        check("a reason is given", isinstance(body.get("reason"), str) and body["reason"])

        # ── Bad input must not kill the sidecar ────────────────────────
        section("Bad input is rejected without taking the service down")
        for name, payload in [
            ("no image field", {"nope": 1}),
            ("image is not a string", {"image": 42}),
            ("image is not base64", {"image": "%%%%"}),
            ("image is base64 of nothing useful", {"image": base64.b64encode(b"xx").decode()}),
            ("body is not JSON", "{{{"),
        ]:
            status, _ = post(f"{base}/segment", payload)
            check(f"{name} → 4xx", 400 <= status < 500, f"got {status}")

        status, body = post(f"{base}/segment", {"image": as_data_url(frame)})
        check("the service still works after all of that", status == 200 and body.get("corridor"))

        section("Routing")
        status, _ = post(f"{base}/nope", {"image": "x"})
        check("an unknown POST route is a 404", status == 404, str(status))
        try:
            urllib.request.urlopen(f"{base}/nope", timeout=5)
            check("an unknown GET route is a 404", False)
        except urllib.error.HTTPError as err:
            check("an unknown GET route is a 404", err.code == 404, str(err.code))

        section("Stats")
        with urllib.request.urlopen(f"{base}/health", timeout=10) as res:
            health = json.loads(res.read())
        check("requests are counted", health["requests"] >= 2, str(health["requests"]))
        check("refusals are counted separately from corridors",
              health["corridors"] >= 1 and health["refusals"] >= 1,
              f"{health['corridors']} / {health['refusals']}")
        check("errors are counted", health["errors"] >= 4, str(health["errors"]))
        check("latency percentiles are reported", health["latencyMs"]["p95"] > 0)
    finally:
        server.shutdown()
        server.server_close()

_colour = "\033[32m" if _failed == 0 else "\033[31m"
print(f"\n{_colour}{_passed} passed, {_failed} failed\033[0m\n")
sys.exit(1 if _failed else 0)
