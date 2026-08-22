"""The four surface signals, measured the way the browser measures them.

Ported from `src/cv/metrics.ts` rather than reinvented. The point of calibrating
offline is to hand the browser numbers it can use directly, and that only works
if both sides compute the same quantity from the same pixels. A Laplacian taken
over a different neighbourhood, or a saturation defined as S in HSL instead of
HSV, produces anchors that are internally consistent and wrong for the consumer.

Where this differs from the browser it is on purpose and noted: this runs
offline over a whole clip at full rate, so it can afford passes the live loop
cannot.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


@dataclass(frozen=True)
class Signals:
    """Matches `Signals` in src/types.ts."""

    glare: float
    texture: float
    darkness: float
    specular: float

    def to_json(self) -> dict[str, float]:
        return {
            "glare": round(self.glare, 6),
            "texture": round(self.texture, 3),
            "darkness": round(self.darkness, 6),
            "specular": round(self.specular, 6),
        }


@dataclass(frozen=True)
class SurfaceStats:
    """Everything one frame's road surface tells us."""

    signals: Signals
    luma: float
    saturation: float
    pixels: int


def measure(frame_bgr: np.ndarray, mask: np.ndarray, glare_v: float = 0.72,
            glare_s: float = 0.22) -> SurfaceStats | None:
    """Measure the four signals over the masked road surface.

    `mask` is a boolean array the same size as the frame. Only those pixels are
    read — which is the whole point: a signal averaged over sky and grass is a
    number about the scene, not about the track.
    """
    if mask.shape != frame_bgr.shape[:2]:
        raise ValueError(f"mask {mask.shape} does not match frame {frame_bgr.shape[:2]}")

    count = int(mask.sum())
    if count < 200:
        return None

    b, g, r = (frame_bgr[..., i].astype(np.float32) for i in range(3))
    # Rec. 601, the same weighting the browser uses.
    luma = 0.299 * r + 0.587 * g + 0.114 * b

    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    sat = np.divide(mx - mn, np.where(mx == 0, 1, mx))

    # Specular: bright *and* near-colourless. A bright red car is not a
    # reflection, and separating those two is the difference between measuring
    # water and measuring livery.
    specular_px = (luma >= glare_v * 255) & (sat <= glare_s)

    # 4-neighbour Laplacian, matching the browser's kernel exactly. cv2's
    # CV_64F Laplacian uses the same 3x3 stencil.
    lap = cv2.Laplacian(luma, cv2.CV_32F, ksize=1)

    # Erode before taking the variance: a Laplacian at the mask boundary reads
    # the step from road to grass, which is a huge edge and has nothing to do
    # with the surface texture. The browser avoids this by sampling inside a
    # region it already inset; here the mask can hug the true boundary, so the
    # inset has to be applied explicitly.
    interior = cv2.erode(mask.astype(np.uint8), np.ones((3, 3), np.uint8), iterations=1).astype(bool)
    if interior.sum() < 100:
        interior = mask

    lap_in = lap[interior]
    luma_in = luma[mask]
    sat_in = sat[mask]

    p50, p95 = np.percentile(luma_in, [50, 95])

    return SurfaceStats(
        signals=Signals(
            glare=float(specular_px[mask].mean()),
            texture=float(lap_in.var()),
            darkness=float(1.0 - luma_in.mean() / 255.0),
            specular=float((p95 - p50) / 255.0),
        ),
        luma=float(luma_in.mean()),
        saturation=float(sat_in.mean()),
        pixels=count,
    )
