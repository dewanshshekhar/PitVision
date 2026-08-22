"""The road-segmentation sidecar.

A small HTTP service that takes a frame and returns a corridor. It runs beside
the Node backend rather than inside it because the model is a Python artefact
and fine-tuning it is a Python job; putting an ONNX runtime inside the Node
process would mean two copies of the model story.

Latency is handled by *rate*, not by speed. The browser asks a few times a
second and reuses the answer in between, exactly as it already does with the
in-browser geometric tracer. A road does not move between two frames 40 ms
apart, so a 60 ms inference every 300 ms costs nothing on a path budgeted at
100 ms per frame — while a 60 ms inference on every frame would blow it six
times over. Nothing here is on the critical path, and if this process is not
running the detector carries on with the geometric tracer.

Built on the standard library. A local sidecar serving a handful of requests a
second does not need an ASGI stack, and a garage laptop with no network does
not need `pip install` to have gone well.

    python -m pitvision_ml.service --model yolopv2
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
import numpy as np

from .config import REGISTRY, CorridorConfig, ServiceConfig
from .corridor import corridor_from_masks
from .segmenter import RoadSegmenter, load

_DATA_URL = re.compile(rb"^data:image/(jpeg|jpg|png|webp);base64,", re.I)
#: Frames are already downscaled by the browser; anything larger is a mistake.
MAX_BODY = 8 * 1024 * 1024


class Stats:
    """Rolling counters, so `/health` says something useful under load."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.requests = 0
        self.corridors = 0
        self.refusals = 0
        self.errors = 0
        self.latencies: list[float] = []

    def record(self, ms: float, *, corridor: bool) -> None:
        with self.lock:
            self.requests += 1
            if corridor:
                self.corridors += 1
            else:
                self.refusals += 1
            self.latencies.append(ms)
            if len(self.latencies) > 240:
                self.latencies.pop(0)

    def snapshot(self) -> dict:
        with self.lock:
            lat = sorted(self.latencies)
            p = lambda q: round(lat[min(len(lat) - 1, int(len(lat) * q))], 2) if lat else 0.0
            return {
                "requests": self.requests,
                "corridors": self.corridors,
                "refusals": self.refusals,
                "errors": self.errors,
                "latencyMs": {"p50": p(0.5), "p95": p(0.95)},
            }


def decode_frame(payload: bytes) -> np.ndarray:
    """Decode a data: URL or raw base64 into a BGR frame.

    Every failure here is the caller's, so every failure must surface as a
    ValueError and become a 400. That takes some care: `b64decode` with
    `validate=False` silently *discards* characters outside the alphabet, so a
    body of pure junk decodes to zero bytes instead of raising, and the error
    then appears several lines later as an OpenCV exception — which reads as a
    server fault and is reported as a 500. A client sending nonsense should be
    told it sent nonsense, not told the service broke.
    """
    body = _DATA_URL.sub(b"", payload.strip())
    # Line breaks are legal in transport-encoded base64 and common in data URLs
    # copied by hand; strip them before validating so they are not read as junk.
    body = re.sub(rb"\s+", b"", body)
    if not body:
        raise ValueError("image is empty")

    try:
        raw = base64.b64decode(body, validate=True)
    except Exception as err:  # noqa: BLE001 - reported to the caller as a 400
        raise ValueError(f"image is not valid base64: {err}") from err

    if len(raw) < 64:
        raise ValueError(f"image is too small to be a frame ({len(raw)} bytes)")

    try:
        frame = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    except cv2.error as err:
        raise ValueError(f"image could not be decoded: {err}") from err
    if frame is None or frame.size == 0:
        raise ValueError("image could not be decoded as jpeg, png or webp")
    return frame


class Handler(BaseHTTPRequestHandler):
    server_version = "PitVisionSeg/1.0"

    segmenter: RoadSegmenter
    corridor_cfg: CorridorConfig
    stats: Stats
    model_name: str

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 - stdlib hook
        # The default logs every request to stderr; the service reports through
        # /health and its own error path instead.
        pass

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - stdlib hook
        if self.path.rstrip("/") in ("/health", ""):
            self._send(200, {
                "ok": True,
                "model": self.model_name,
                "inputSize": list(self.segmenter.input_size),
                "providers": self.segmenter.providers,
                "warmed": self.segmenter.warmed,
                **self.stats.snapshot(),
            })
            return
        self._send(404, {"error": f"no route GET {self.path}"})

    def do_POST(self) -> None:  # noqa: N802 - stdlib hook
        if self.path.rstrip("/") != "/segment":
            self._send(404, {"error": f"no route POST {self.path}"})
            return

        length = int(self.headers.get("content-length") or 0)
        if length <= 0 or length > MAX_BODY:
            self._send(413, {"error": f"body must be between 1 and {MAX_BODY} bytes"})
            return

        started = time.perf_counter()
        try:
            payload = json.loads(self.rfile.read(length))
            image = payload.get("image")
            if not isinstance(image, str):
                raise ValueError("expected `image` as a base64 string or data: URL")

            frame = decode_frame(image.encode())
            out = self.segmenter.infer(frame)
            corridor = corridor_from_masks(out.road, out.lane, self.corridor_cfg, frame)

            total_ms = (time.perf_counter() - started) * 1000
            self.stats.record(total_ms, corridor=corridor is not None)

            if corridor is None or corridor.confidence < self.corridor_cfg.min_confidence:
                # A refusal is a real answer and the caller has somewhere to
                # fall back to. Reporting a low-confidence corridor as if it
                # were a good one is the failure that puts a wetness index on a
                # pit wall for a region that is not track.
                self._send(200, {
                    "corridor": None,
                    "reason": "no confident road surface in this frame",
                    "confidence": corridor.confidence if corridor else 0.0,
                    "timing": {
                        "inferenceMs": round(out.inference_ms, 2),
                        "totalMs": round(total_ms, 2),
                    },
                })
                return

            self._send(200, {
                "corridor": corridor.to_json(),
                "model": self.model_name,
                "timing": {
                    "inferenceMs": round(out.inference_ms, 2),
                    "totalMs": round(total_ms, 2),
                },
            })
        except ValueError as err:
            self.stats.errors += 1
            self._send(400, {"error": str(err)})
        except Exception as err:  # noqa: BLE001 - the sidecar must not die on one frame
            self.stats.errors += 1
            self._send(500, {"error": f"{type(err).__name__}: {err}"})


def serve(cfg: ServiceConfig) -> None:
    print(f"loading {cfg.model} from {cfg.models_dir} …", file=sys.stderr)
    segmenter = load(cfg.model, cfg.models_dir, threads=cfg.threads)

    warm_ms = segmenter.warm_up()
    print(
        f"ready: {cfg.model} {segmenter.input_size} on {segmenter.providers[0]} "
        f"({warm_ms:.0f} ms/frame warm)",
        file=sys.stderr,
    )

    Handler.segmenter = segmenter
    Handler.corridor_cfg = cfg.corridor
    Handler.stats = Stats()
    Handler.model_name = cfg.model

    server = ThreadingHTTPServer((cfg.host, cfg.port), Handler)
    server.daemon_threads = True
    print(f"listening on http://{cfg.host}:{cfg.port}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="PitVision road-segmentation sidecar")
    ap.add_argument("--model", default=ServiceConfig.model, choices=sorted(REGISTRY))
    ap.add_argument("--models-dir", type=Path, default=ServiceConfig.models_dir)
    ap.add_argument("--host", default=ServiceConfig.host)
    ap.add_argument("--port", type=int, default=ServiceConfig.port)
    ap.add_argument("--threads", type=int, default=ServiceConfig.threads)
    args = ap.parse_args(argv)

    try:
        serve(ServiceConfig(
            host=args.host,
            port=args.port,
            model=args.model,
            models_dir=args.models_dir,
            threads=args.threads,
        ))
    except FileNotFoundError as err:
        print(f"\n{err}\n", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
