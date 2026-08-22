"""Generate short clips with known surface properties.

These are not a substitute for real footage and nothing here validates whether
the anchors are *right* — that needs a real circuit and is the reason
`calibrate.py` takes your clips rather than shipping constants.

What they do validate is the part that is checkable in isolation: that the
script reads video, finds a road, measures inside it, and reaches the correct
*branch*. The branch decision is the piece most likely to be silently wrong, and
it is decidable from footage with known properties — a bright, high-texture,
non-specular surface must anchor dry, and a dark, smooth, specular one must not.
"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np


def write_clip(path: Path, *, wet_from: float | None, frames: int = 120,
               w: int = 640, h: int = 360, seed: int = 3) -> None:
    """A trackside view. `wet_from` is the fraction of the clip after which the
    surface turns wet: darker, smoother, and carrying specular highlights."""
    rng = np.random.default_rng(seed)
    path.parent.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 25, (w, h))
    if not writer.isOpened():
        raise SystemExit(f"could not open a writer for {path}")

    for f in range(frames):
        wet = wet_from is not None and (f / frames) >= wet_from
        frame = np.zeros((h, w, 3), dtype=np.uint8)
        frame[: int(0.34 * h)] = (215, 170, 130)  # sky

        for y in range(int(0.34 * h), h):
            t = (y / h - 0.34) / 0.66
            half = 0.09 + 0.30 * t
            l, r = int((0.5 - half) * w), int((0.5 + half) * w)
            frame[y, :l] = (46, 106, 56)
            frame[y, r:] = (46, 106, 56)

            span = r - l
            if span <= 0:
                continue
            if wet:
                # Water: darker base, aggregate filled in, mirrored highlights.
                base = 74 + rng.integers(-4, 4, span)
                px = np.clip(base, 0, 255)
                shine = rng.random(span) < 0.05
                px[shine] = 245
            else:
                # Dry asphalt: mid-bright with strong aggregate speckle.
                px = np.clip(126 + rng.integers(-26, 26, span), 0, 255)
            frame[y, l:r] = px[:, None]

        if wet:
            # Blur the road band before writing.
            #
            # Without this the "wet" surface is physically wrong in the one way
            # that matters most here. Water fills the aggregate voids and
            # mirrors the sky, so a wet surface is *smoother* than a dry one and
            # its Laplacian variance collapses — that is the single signal with
            # real separation between the two states. Painting single-pixel
            # highlights produces salt-and-pepper noise instead, which sends the
            # Laplacian through the roof: measured at 26,000 against a dry
            # reading of 4,400, when the truth is the other way round.
            #
            # A calibration run against that fixture correctly reported "no wet
            # track present", because there was none. The fixture was wrong, not
            # the detector — which is a fair demonstration of why the anchors
            # have to come from real footage.
            band = frame[int(0.34 * h):, :]
            frame[int(0.34 * h):, :] = cv2.GaussianBlur(band, (0, 0), 2.4)

        writer.write(frame)
    writer.release()


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "clips")
    write_clip(out / "dry.mp4", wet_from=None)
    write_clip(out / "wet.mp4", wet_from=0.0, seed=9)
    write_clip(out / "mixed.mp4", wet_from=0.5, seed=11)
    for p in sorted(out.glob("*.mp4")):
        print(f"  {p}  {p.stat().st_size >> 10} KiB")
