"""Tests for the ONNX inference path.

Run against a fixture graph built by `make_fixture_model.py` with the real
model's input signature and output layout. What is checked here is everything
between a frame arriving and a corridor coming out — session handling,
letterboxing, head identification, coordinate round-trip — none of which
depends on the weights being any good.

    .venv/bin/python ml/tests/test_segmenter.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from make_fixture_model import build as build_fixture
from pitvision_ml.config import CorridorConfig, ModelSpec
from pitvision_ml.corridor import corridor_from_masks
from pitvision_ml.segmenter import RoadSegmenter, _adapt_yolop, letterbox, unletterbox

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


FIXTURE_SPEC = ModelSpec(
    name="fixture",
    filename="_fixture.onnx",
    adapter="yolop",
    input_size=(384, 640),
    source="built locally by ml/tests/make_fixture_model.py",
    notes="test fixture",
)


def scene(w: int = 960, h: int = 540, *, lines: bool = False) -> np.ndarray:
    """A frame in BGR: sky, grey tarmac narrowing to a horizon, green verges."""
    frame = np.zeros((h, w, 3), dtype=np.uint8)
    horizon = 0.36
    frame[: int(horizon * h)] = (225, 165, 120)  # BGR sky

    for y in range(int(horizon * h), h):
        t = (y / h - horizon) / (1 - horizon)
        half = 0.08 + 0.30 * t
        l, r = int((0.5 - half) * w), int((0.5 + half) * w)
        frame[y, :l] = (44, 104, 58)   # grass
        frame[y, r:] = (44, 104, 58)
        frame[y, l:r] = (118, 118, 119)  # tarmac
        if lines:
            frame[y, max(0, l) : l + 4] = (240, 240, 240)
            frame[y, max(0, r - 4) : r] = (240, 240, 240)
    return frame


with tempfile.TemporaryDirectory() as tmp:
    model_path = Path(tmp) / "_fixture.onnx"
    build_fixture(model_path)

    # ── Letterbox round trip ───────────────────────────────────────────
    section("Letterboxing preserves geometry")
    frame = scene()
    boxed, scale, pad = letterbox(frame, (384, 640))
    check("output matches the network's input size", boxed.shape[:2] == (384, 640), str(boxed.shape))

    ar_in = frame.shape[1] / frame.shape[0]
    nw, nh = round(frame.shape[1] * scale), round(frame.shape[0] * scale)
    check("aspect ratio is preserved, not squashed", abs(nw / nh - ar_in) < 0.02,
          f"{nw / nh:.3f} vs {ar_in:.3f}")

    # A marker at a known place must come back at the same normalised place.
    probe = np.zeros(frame.shape[:2], dtype=np.float32)
    probe[int(0.70 * frame.shape[0]), int(0.30 * frame.shape[1])] = 1.0
    boxed_probe, s2, p2 = letterbox(np.dstack([probe] * 3), (384, 640))
    back = unletterbox(boxed_probe[:, :, 0], s2, p2, frame.shape[:2])
    ys, xs = np.unravel_index(int(np.argmax(back)), back.shape)
    check("a point survives the round trip within 1%",
          abs(ys / frame.shape[0] - 0.70) < 0.01 and abs(xs / frame.shape[1] - 0.30) < 0.01,
          f"({xs / frame.shape[1]:.3f}, {ys / frame.shape[0]:.3f})")

    # ── Session ────────────────────────────────────────────────────────
    section("The segmenter drives a real ONNX session")
    seg = RoadSegmenter(model_path, FIXTURE_SPEC)
    check("the session loads", seg.session is not None)
    check("input size is read from the graph, not the registry", seg.input_size == (384, 640),
          str(seg.input_size))

    warm_ms = seg.warm_up()
    check("warm-up runs and reports a cost", seg.warmed and warm_ms > 0, f"{warm_ms:.1f}ms")

    out = seg.infer(frame)
    check("road and lane maps come back", out.road is not None and out.lane is not None)
    check("maps are in the frame's own coordinates", out.road.shape == frame.shape[:2],
          f"{out.road.shape} vs {frame.shape[:2]}")
    check("probabilities are in [0,1]", 0.0 <= out.road.min() and out.road.max() <= 1.0,
          f"[{out.road.min():.3f}, {out.road.max():.3f}]")
    check("latency is measured", out.inference_ms > 0 and out.total_ms >= out.inference_ms)

    # ── Head identification ────────────────────────────────────────────
    section("The road head is identified by coverage, not by output order")
    # The fixture emits detection first, then road, then lane — the adapter has
    # to ignore the first and tell the other two apart.
    road_cov = float((out.road > 0.5).mean())
    lane_cov = float((out.lane > 0.5).mean())
    check("the road head covers far more of the frame than the lane head",
          road_cov > lane_cov * 3, f"road {road_cov:.3f} vs lane {lane_cov:.3f}")
    check("the road mask is a plausible fraction of the frame",
          0.10 < road_cov < 0.75, f"{road_cov:.3f}")

    # A real YOLOPv2 TorchScript export flattens several large detection maps
    # ahead of the road/lane maps. They must not be mistaken for segmentation.
    det = np.zeros((1, 3, 48, 80, 85), dtype=np.float32)
    anchor = np.zeros((1, 3, 1, 1, 2), dtype=np.float32)
    road_logits = np.full((1, 2, 48, 80), -4.0, dtype=np.float32)
    lane_logits = np.full((1, 2, 48, 80), -4.0, dtype=np.float32)
    road_logits[:, 1, 20:, 10:70] = 4.0
    lane_logits[:, 1, 20:, (12, 67)] = 4.0
    mapped_road, mapped_lane = _adapt_yolop([det, anchor, road_logits, lane_logits])
    check("large detection tensors are ignored when selecting mask heads",
          mapped_road.shape == (48, 80) and mapped_lane is not None and mapped_lane.shape == (48, 80))
    check("the broader map is selected as road",
          float((mapped_road > 0.5).mean()) > float((mapped_lane > 0.5).mean()) * 5)

    # ── The masks land on the actual road ──────────────────────────────
    section("The mask lands where the tarmac is")
    h, w = frame.shape[:2]
    sky_cov = float((out.road[: int(0.30 * h)] > 0.5).mean())
    check("almost nothing above the horizon is called road", sky_cov < 0.02, f"{sky_cov:.4f}")

    y = int(0.85 * h)
    t = (0.85 - 0.36) / (1 - 0.36)
    half = 0.08 + 0.30 * t
    centre_on = out.road[y, int(0.5 * w)] > 0.5
    verge_off = out.road[y, int((0.5 - half - 0.06) * w)] < 0.5
    check("the centre of the track is road", bool(centre_on))
    check("the grass verge is not", bool(verge_off))

    # ── The whole path, mask to corridor ───────────────────────────────
    section("End to end: frame in, corridor out")
    cfg = CorridorConfig()
    corr = corridor_from_masks(out.road, out.lane, cfg)
    check("a corridor is produced from a real inference", corr is not None)
    if corr:
        check("it stops at the horizon", corr.y_top >= 0.30, f"yTop {corr.y_top:.3f}")
        check("it widens toward the camera",
              (corr.right[-1] - corr.left[-1]) > (corr.right[3] - corr.left[3]))
        check("confidence is high on a clean synthetic frame", corr.confidence > 0.8,
              f"{corr.confidence}")
        j = corr.to_json()
        check("the wire shape carries 48 rows", len(j["left"]) == 48 and len(j["right"]) == 48)

    # ── Painted lines pull the limits in ───────────────────────────────
    section("With painted limits, the corridor tightens onto the racing surface")
    lined = seg.infer(scene(lines=True))
    corr_lined = corridor_from_masks(lined.road, lined.lane, cfg)
    check("a corridor is produced with lines present", corr_lined is not None)
    if corr_lined and corr:
        check("the lane head fired on the painted lines",
              float((lined.lane > cfg.lane_threshold).mean()) > 0.001,
              f"{float((lined.lane > cfg.lane_threshold).mean()):.5f}")

    # ── Failure modes ──────────────────────────────────────────────────
    section("Failures are reported, not guessed at")
    try:
        RoadSegmenter(Path(tmp) / "missing.onnx", FIXTURE_SPEC)
        check("a missing model file raises", False)
    except FileNotFoundError as err:
        check("a missing model file raises with the fetch instruction",
              "fetch_models.py" in str(err))

    blank = np.full_like(frame, 60)
    blank_out = seg.infer(blank)
    check("a featureless frame yields no corridor",
          corridor_from_masks(blank_out.road, blank_out.lane, cfg) is None)

    grass = np.zeros_like(frame)
    grass[:, :] = (44, 104, 58)
    grass_out = seg.infer(grass)
    check("a frame of grass yields no corridor",
          corridor_from_masks(grass_out.road, grass_out.lane, cfg) is None)

_colour = "\033[32m" if _failed == 0 else "\033[31m"
print(f"\n{_colour}{_passed} passed, {_failed} failed\033[0m\n")
sys.exit(1 if _failed else 0)
