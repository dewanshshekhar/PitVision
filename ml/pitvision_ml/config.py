"""Configuration for the road-segmentation service.

Every threshold here has a reason attached. A number without one is a number
nobody can safely change later.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = Path(os.environ.get("PITVISION_MODELS_DIR", ROOT / "models"))


@dataclass(frozen=True)
class ModelSpec:
    """A segmentation model this service knows how to drive.

    `adapter` names the output layout, not the architecture — two models with
    the same heads in the same order are the same adapter.
    """

    name: str
    filename: str
    adapter: str
    input_size: tuple[int, int]  # (height, width) the network expects
    #: Where the weights come from, for `scripts/fetch_models.py`.
    source: str
    notes: str


#: Models the service can load, best first.
#:
#: Both are trained on BDD100K — 100k real driving videos spanning rain, night,
#: glare and overcast. That is the reason for choosing them over a model trained
#: on clean daytime footage: the conditions this project exists to measure are
#: exactly the conditions that break a model trained on easy data.
#:
#: The domain gap is real and worth stating plainly. BDD100K is public roads.
#: A race track differs in ways that matter:
#:
#:   - Run-off is often asphalt, so a "drivable area" head will happily include
#:     it. The racing surface is bounded by the white line, not by where the
#:     tarmac ends. `track.py` is what recovers that boundary.
#:   - Kerbs are red/white rumble strips, not urban granite.
#:   - There are no urban lane markings, junctions, or pavements.
#:
#: Which is why `scripts/finetune.py` exists. Out of the box these models find
#: the tarmac; fine-tuned on a few hundred frames of the actual circuit they
#: find the racing surface.
REGISTRY: dict[str, ModelSpec] = {
    "yolopv2": ModelSpec(
        name="yolopv2",
        filename="yolopv2.onnx",
        adapter="yolop",
        input_size=(384, 640),
        source="https://github.com/CAIC-AD/YOLOPv2",
        notes=(
            "Panoptic driving perception: detection, drivable area, lane lines. "
            "Reported 0.93 mIoU drivable area on BDD100K. Heavier but the most "
            "accurate of the two."
        ),
    ),
    "twinlitenet": ModelSpec(
        name="twinlitenet",
        filename="twinlitenet.onnx",
        adapter="twinlite",
        input_size=(360, 640),
        source="https://github.com/chequanghuy/TwinLiteNet",
        notes=(
            "Drivable area + lane lines only, ~0.4M parameters. Built for "
            "embedded real-time. Use when the machine in the garage is a laptop "
            "doing three other things."
        ),
    ),
}

DEFAULT_MODEL = os.environ.get("PITVISION_SEG_MODEL", "yolopv2")


@dataclass(frozen=True)
class CorridorConfig:
    """How a segmentation mask becomes a corridor."""

    #: Rows sampled across the corridor. Matches ROWS in src/cv/lane.ts — the
    #: browser consumes this array directly and a mismatch is a silent resample.
    rows: int = 48

    #: Probability above which a pixel counts as road.
    #:
    #: Deliberately above 0.5. A segmentation head is calibrated for IoU, which
    #: rewards claiming borderline pixels; this pipeline then *measures* those
    #: pixels, so a false positive on the verge costs a wrong wetness index
    #: rather than a fractionally worse score. Being strict at the boundary is
    #: the right trade here.
    road_threshold: float = 0.62

    #: Probability above which a pixel counts as lane marking.
    lane_threshold: float = 0.45

    #: A row must be at least this wide, as a fraction of frame width, to count.
    min_row_width: float = 0.03

    #: Rows measured, as a fraction of the reported span, below which the
    #: corridor is not trusted and the caller falls back.
    min_confidence: float = 0.55

    #: Scale for the pixel-scale gap merge that runs before the continuity test.
    #:
    #: Whether a *real* hole is bridged is decided by width continuity with the
    #: row below, not by this number — see `corridor._row_run`. A car directly
    #: ahead can occupy a fifth of the frame, which is wider than the kerb the
    #: scan must not jump, so no single width budget separates the two. This
    #: only closes quantisation gaps so they cannot fragment the continuity test.
    max_bridge: float = 0.18

@dataclass(frozen=True)
class ServiceConfig:
    host: str = os.environ.get("PITVISION_ML_HOST", "127.0.0.1")
    port: int = int(os.environ.get("PITVISION_ML_PORT", "8788"))
    model: str = DEFAULT_MODEL
    models_dir: Path = MODELS_DIR
    #: ONNX Runtime intra-op threads. 0 lets the runtime decide.
    threads: int = int(os.environ.get("PITVISION_ML_THREADS", "0"))
    corridor: CorridorConfig = field(default_factory=CorridorConfig)
