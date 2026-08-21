"""ONNX road segmentation.

Deliberately thin. The interesting decisions live in `corridor.py`; this is
pre-processing, one `session.run`, and post-processing back into the original
frame's coordinates. The reason it is its own module is that the *only* thing
that differs between the models this project can use is the shape of what comes
out, and pinning that difference to one adapter function keeps a model swap from
touching anything else.

There is no PyTorch dependency at inference time. Weights arrive as ONNX and are
executed by ONNX Runtime, which means the garage machine needs a 25 MB wheel
rather than a 900 MB one, and the same file runs on CPU, CUDA, OpenVINO or a
Hailo NPU without a code change.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import cv2
import numpy as np
import onnxruntime as ort

from .config import ModelSpec, REGISTRY


@dataclass
class SegOutput:
    """Road and lane probabilities in the *original* frame's coordinates."""

    road: np.ndarray
    lane: np.ndarray | None
    inference_ms: float
    total_ms: float


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(x, -30, 30)))


def _softmax_channel(x: np.ndarray, axis: int = 0) -> np.ndarray:
    e = np.exp(x - x.max(axis=axis, keepdims=True))
    return e / e.sum(axis=axis, keepdims=True)


def _to_prob(head: np.ndarray) -> np.ndarray:
    """Collapse one segmentation head to a single-channel probability map.

    Segmentation heads are published in three shapes and the difference is
    silent: two channels meaning (background, foreground) via softmax, one
    channel meaning a logit via sigmoid, and one channel already in [0, 1].
    Guessing wrong does not crash — it produces a mask that is subtly inverted
    or saturated, which is exactly the kind of failure that ends up on a pit
    wall looking authoritative. So each case is detected rather than assumed.
    """
    head = np.squeeze(head)
    if head.ndim == 3:
        if head.shape[0] == 2:
            return _softmax_channel(head, axis=0)[1]
        if head.shape[-1] == 2:
            return _softmax_channel(head.transpose(2, 0, 1), axis=0)[1]
        if head.shape[0] == 1:
            head = head[0]
        elif head.shape[-1] == 1:
            head = head[..., 0]
        else:
            raise ValueError(f"cannot interpret segmentation head of shape {head.shape}")

    if head.ndim != 2:
        raise ValueError(f"expected a 2-D map after squeeze, got {head.shape}")

    lo, hi = float(head.min()), float(head.max())
    # Already probabilities if it sits inside [0,1] with some spread; a logit
    # map spans negatives or well past 1.
    if lo >= -1e-6 and hi <= 1.0 + 1e-6:
        return head.astype(np.float32)
    return _sigmoid(head).astype(np.float32)


# ── Adapters ───────────────────────────────────────────────────────────
#
# One function per output layout. Each takes the raw ONNX outputs and returns
# (road_head, lane_head_or_None). Nothing else in the codebase knows or cares
# what order a given network emits its heads in.

Adapter = Callable[[list[np.ndarray]], tuple[np.ndarray, np.ndarray | None]]


def _adapt_yolop(outputs: list[np.ndarray]) -> tuple[np.ndarray, np.ndarray | None]:
    """YOLOP / YOLOPv2: detection, drivable area, lane line.

    The detection head is ignored — this project does not need to know where the
    other cars are, only which pixels are track. The two segmentation heads are
    identified by shape rather than by index, because export scripts in the wild
    order them inconsistently and an off-by-one here silently swaps road for
    lane markings.
    """
    # A TorchScript YOLOPv2 export flattens its nested detection tuple into
    # several ONNX outputs before the two segmentation maps. Detection tensors
    # can also be large, so size alone does not identify a segmentation head.
    # Keep only values that can actually collapse to a plausible spatial map.
    probs: list[np.ndarray] = []
    for output in outputs:
        try:
            prob = _to_prob(output)
        except ValueError:
            continue
        h, w = prob.shape
        aspect = w / max(1, h)
        if h >= 16 and w >= 16 and 0.25 <= aspect <= 4.0:
            probs.append(prob)

    if len(probs) < 2:
        raise ValueError(
            f"expected two segmentation heads, found {len(probs)} in outputs "
            f"with shapes {[o.shape for o in outputs]}"
        )
    # Drivable area covers far more pixels than lane markings, at the same
    # resolution. That ratio is the reliable discriminator.
    probs = sorted(probs, key=lambda p: p.size, reverse=True)[:2]
    coverage = [float((p > 0.5).mean()) for p in probs]
    road_i = int(np.argmax(coverage))
    lane_i = 1 - road_i
    return probs[road_i], probs[lane_i]


def _adapt_twinlite(outputs: list[np.ndarray]) -> tuple[np.ndarray, np.ndarray | None]:
    """TwinLiteNet: drivable area, lane line. Same discriminator, no detection head."""
    return _adapt_yolop(outputs)


def _adapt_single(outputs: list[np.ndarray]) -> tuple[np.ndarray, np.ndarray | None]:
    """A plain binary road segmenter — what `finetune.py` produces."""
    return _to_prob(outputs[0]), None


ADAPTERS: dict[str, Adapter] = {
    "yolop": _adapt_yolop,
    "twinlite": _adapt_twinlite,
    "single": _adapt_single,
}


def letterbox(
    frame: np.ndarray, size: tuple[int, int]
) -> tuple[np.ndarray, float, tuple[int, int]]:
    """Resize preserving aspect ratio, padding the remainder.

    Squashing to the network's aspect ratio instead would change the apparent
    geometry of the road, and every downstream number is a measurement of that
    geometry. The scale and padding are returned so the mask can be mapped back
    onto the real frame exactly.
    """
    th, tw = size
    h, w = frame.shape[:2]
    scale = min(tw / w, th / h)
    nw, nh = int(round(w * scale)), int(round(h * scale))
    resized = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_LINEAR)

    out = np.full((th, tw, 3), 114, dtype=frame.dtype)
    px, py = (tw - nw) // 2, (th - nh) // 2
    out[py : py + nh, px : px + nw] = resized
    return out, scale, (px, py)


def unletterbox(
    mask: np.ndarray, scale: float, pad: tuple[int, int], original: tuple[int, int]
) -> np.ndarray:
    """Undo `letterbox` for a single-channel map."""
    h, w = original
    px, py = pad
    nh, nw = int(round(h * scale)), int(round(w * scale))
    crop = mask[py : py + nh, px : px + nw]
    if crop.size == 0:
        return np.zeros((h, w), dtype=np.float32)
    return cv2.resize(crop, (w, h), interpolation=cv2.INTER_LINEAR)


class RoadSegmenter:
    """Loads an ONNX model once and runs it on frames."""

    def __init__(
        self,
        model_path: Path,
        spec: ModelSpec,
        threads: int = 0,
        providers: list[str] | None = None,
    ) -> None:
        if not model_path.exists():
            raise FileNotFoundError(
                f"No model at {model_path}. Run `python ml/scripts/fetch_models.py "
                f"--model {spec.name}` on a machine that can reach {spec.source}."
            )

        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        if threads > 0:
            opts.intra_op_num_threads = threads

        available = ort.get_available_providers()
        chosen = [p for p in (providers or ["CUDAExecutionProvider", "CPUExecutionProvider"])
                  if p in available] or ["CPUExecutionProvider"]

        self.session = ort.InferenceSession(str(model_path), opts, providers=chosen)
        self.spec = spec
        self.adapter = ADAPTERS[spec.adapter]
        self.input_name = self.session.get_inputs()[0].name
        self.providers = chosen

        shape = self.session.get_inputs()[0].shape
        # A fixed spatial dimension in the graph always beats the registry,
        # which is only a default and goes stale the moment anyone re-exports.
        h = shape[2] if isinstance(shape[2], int) else spec.input_size[0]
        w = shape[3] if isinstance(shape[3], int) else spec.input_size[1]
        self.input_size = (int(h), int(w))

        self._warm = False

    def warm_up(self, rounds: int = 3) -> float:
        """Run the graph on a blank frame before it is needed.

        First inference on a fresh session is several times slower than the
        steady state — arena allocation, kernel selection, weight paging. This
        is the same reason the browser pre-race check touches every buffer: the
        cost is unavoidable, so it is paid before the session rather than during
        it.
        """
        h, w = self.input_size
        blank = np.zeros((1, 3, h, w), dtype=np.float32)
        t0 = time.perf_counter()
        for _ in range(rounds):
            self.session.run(None, {self.input_name: blank})
        self._warm = True
        return (time.perf_counter() - t0) * 1000 / max(1, rounds)

    @property
    def warmed(self) -> bool:
        return self._warm

    def infer(self, frame_bgr: np.ndarray) -> SegOutput:
        """Segment one frame. Returns maps in the frame's own coordinates."""
        t_start = time.perf_counter()
        h, w = frame_bgr.shape[:2]

        boxed, scale, pad = letterbox(frame_bgr, self.input_size)
        rgb = cv2.cvtColor(boxed, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        tensor = np.ascontiguousarray(rgb.transpose(2, 0, 1)[None])

        t_inf = time.perf_counter()
        outputs = self.session.run(None, {self.input_name: tensor})
        inference_ms = (time.perf_counter() - t_inf) * 1000

        road_head, lane_head = self.adapter(list(outputs))

        # The heads can come back at a different resolution than the input;
        # bring them to the letterboxed size before undoing the letterbox, or
        # the padding offsets refer to the wrong grid.
        th, tw = self.input_size
        if road_head.shape != (th, tw):
            road_head = cv2.resize(road_head, (tw, th), interpolation=cv2.INTER_LINEAR)
        if lane_head is not None and lane_head.shape != (th, tw):
            lane_head = cv2.resize(lane_head, (tw, th), interpolation=cv2.INTER_LINEAR)

        road = unletterbox(road_head, scale, pad, (h, w))
        lane = unletterbox(lane_head, scale, pad, (h, w)) if lane_head is not None else None

        return SegOutput(
            road=road,
            lane=lane,
            inference_ms=inference_ms,
            total_ms=(time.perf_counter() - t_start) * 1000,
        )


def load(model_name: str, models_dir: Path, threads: int = 0) -> RoadSegmenter:
    if model_name not in REGISTRY:
        raise KeyError(f"Unknown model '{model_name}'. Known: {', '.join(REGISTRY)}")
    spec = REGISTRY[model_name]
    return RoadSegmenter(models_dir / spec.filename, spec, threads=threads)
