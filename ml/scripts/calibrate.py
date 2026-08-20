#!/usr/bin/env python3
"""Calibrate PitVision against real footage, before race day.

    python ml/scripts/calibrate.py footage/*.mp4 --out calibration.json

This is the script that replaces guessed constants with measured ones. It reads
your own clips, finds the road in each frame, measures the four surface signals
inside it, and writes a calibration the app loads on startup.

Why it exists
-------------
Two problems it solves that the in-browser calibration cannot.

**The tracer's own thresholds were never measured.** How colourless asphalt is,
and how far its brightness drifts row to row, decide where the traced corridor
stops. Those numbers were chosen against generated scenes, which is exactly the
wrong place to get them: a synthetic road is uniform, and real tarmac is patched,
sun-bleached, rubbered-in and rained-on. This measures them on your circuit.

**Race day should not start with a calibration.** The browser can anchor itself
from a live feed in about fifteen seconds, and that is fine for a practice
session. It is not fine for the moment the lights go out. Run this the day
before on last year's footage, or on this morning's installation lap, and the
app starts already anchored.

What it does not do
-------------------
It does not decide whether the track is wet. It establishes the *scale* the
index is measured on. If your footage is entirely dry, that is a good calibration
input, not a problem — the dry end is measured from your footage and the wet end
is derived from the physics of what water does to a surface. That asymmetry is
deliberate and is explained under `anchors_from` below.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pitvision_ml.config import MODELS_DIR, REGISTRY, CorridorConfig  # noqa: E402
from pitvision_ml.corridor import corridor_from_masks  # noqa: E402
from pitvision_ml.signals import Signals, SurfaceStats, measure  # noqa: E402

# ── Constants ported verbatim from src/cv/autocal.ts ───────────────────
#
# Ported, not re-derived. The whole point is to hand the browser numbers on the
# scale it already uses; a second opinion about what "wet" means would produce a
# calibration that is internally consistent and wrong for its consumer.

WET_OFFSET = {
    "glare_add": 0.045,
    "texture_ratio": 0.35,
    "darkness_add": 0.16,
    "specular_add": 0.22,
}

WET_EVIDENCE = {
    "glare": 0.015,
    "darkness_above": 0.06,
    "texture_below": 0.6,
    "confident_share": 0.30,
    "none_share": 0.10,
    "soaked_share": 0.85,
}

WET_ABSOLUTE = {"texture": 900.0, "darkness": 0.28}

KEYS = ("glare", "texture", "darkness", "specular")


@dataclass
class Report:
    clips: list[str]
    frames_read: int
    frames_measured: int
    road_found_share: float
    branch: str
    verdict: str
    wet_share: float
    dry: dict
    wet: dict
    spread: dict
    tracer: dict
    note: str
    generated_at: str
    road_source: str


def percentile(values: np.ndarray, q: float) -> float:
    return float(np.percentile(values, q * 100)) if values.size else 0.0


# ── Finding the road ───────────────────────────────────────────────────


class GeometricFinder:
    """The fallback road finder: colourless, mid-bright, connected.

    A deliberately simple stand-in for the browser's tracer, used when no
    segmentation model is installed. It is not as good — that is the point of
    installing the model — but it is good enough to *measure* a surface whose
    location is not in dispute, which is all calibration needs.
    """

    name = "geometric"

    def __call__(self, frame: np.ndarray) -> np.ndarray | None:
        b, g, r = (frame[..., i].astype(np.float32) for i in range(3))
        luma = 0.299 * r + 0.587 * g + 0.114 * b
        mx = np.maximum(np.maximum(r, g), b)
        mn = np.minimum(np.minimum(r, g), b)
        sat = np.divide(mx - mn, np.where(mx == 0, 1, mx))

        h, w = luma.shape
        mask = (sat <= 0.30) & (luma > 30) & (luma < 235)
        # Never above the horizon band: overcast sky is grey and mid-bright and
        # would otherwise dominate the sample on exactly the days that matter.
        mask[: int(0.30 * h)] = False

        mask = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))

        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        if n <= 1:
            return None
        # The component reaching furthest down the frame is the surface under
        # the camera; the largest may be an overcast sky above the horizon line.
        best, best_score = 0, -1.0
        for i in range(1, n):
            area = stats[i, cv2.CC_STAT_AREA]
            if area < h * w * 0.02:
                continue
            bottom = stats[i, cv2.CC_STAT_TOP] + stats[i, cv2.CC_STAT_HEIGHT]
            score = area * (2.0 if bottom > h * 0.92 else 1.0)
            if score > best_score:
                best, best_score = i, score
        if best == 0:
            return None

        road = labels == best
        # Inset, for the same reason the corridor is inset: the outer few per
        # cent is white line and kerb, and painted kerbing reads as reflection.
        return cv2.erode(road.astype(np.uint8), np.ones((7, 7), np.uint8), 2).astype(bool)


class SegmentationFinder:
    """The real road finder, when a model is installed."""

    name = "segmentation"

    def __init__(self, model: str, models_dir: Path) -> None:
        from pitvision_ml.segmenter import load  # noqa: PLC0415 - optional path

        self.seg = load(model, models_dir)
        self.seg.warm_up(2)
        self.cfg = CorridorConfig()
        self.name = f"segmentation:{model}"

    def __call__(self, frame: np.ndarray) -> np.ndarray | None:
        out = self.seg.infer(frame)
        corr = corridor_from_masks(out.road, out.lane, self.cfg)
        if corr is None or corr.confidence < self.cfg.min_confidence:
            return None

        # Rasterise the corridor rather than reusing the raw mask, so the pixels
        # measured here are exactly the pixels the browser will measure through
        # the same corridor. Calibrating on a wider region than the one that
        # will be sampled produces anchors that do not describe the sample.
        h, w = frame.shape[:2]
        mask = np.zeros((h, w), dtype=np.uint8)
        rows = len(corr.left)
        ys = np.linspace(corr.y_top * h, corr.y_bot * h, rows).astype(int)
        pts_l = [(int(corr.left[i] * w), int(ys[i])) for i in range(rows)]
        pts_r = [(int(corr.right[i] * w), int(ys[i])) for i in range(rows)]
        cv2.fillPoly(mask, [np.array(pts_l + pts_r[::-1], dtype=np.int32)], 1)
        return mask.astype(bool)


# ── Sampling ───────────────────────────────────────────────────────────


def sample_clip(
    path: Path,
    finder,
    every: int,
    max_frames: int,
    width: int,
) -> tuple[list[SurfaceStats], int]:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise SystemExit(f"could not open {path}")

    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    stats: list[SurfaceStats] = []
    read = 0
    idx = 0

    while len(stats) < max_frames:
        ok, frame = cap.read()
        if not ok:
            break
        idx += 1
        if idx % every:
            continue
        read += 1

        if frame.shape[1] > width:
            scale = width / frame.shape[1]
            frame = cv2.resize(frame, (width, int(frame.shape[0] * scale)),
                               interpolation=cv2.INTER_AREA)

        mask = finder(frame)
        if mask is None:
            continue
        s = measure(frame, mask)
        if s is not None:
            stats.append(s)

        if read % 25 == 0:
            print(f"\r  {path.name}: {len(stats)} measured / {read} read"
                  + (f" of ~{total // every}" if total else ""), end="", file=sys.stderr)

    cap.release()
    print(f"\r  {path.name}: {len(stats)} measured / {read} read", file=sys.stderr)
    return stats, read


# ── Anchoring ──────────────────────────────────────────────────────────


def anchors_from(samples: list[Signals]) -> tuple[dict, dict, dict, str, str, float, str]:
    """Derive dry and wet anchors, following src/cv/autocal.ts exactly.

    The asymmetry between the two ends is the important part and is worth
    restating, because it looks like a shortcut and is the opposite of one.

    Mapping the clip's own low percentile to 0 and its high percentile to 100
    is the obvious implementation and it is wrong: a purely relative scale
    *always* yields a full 0–100 swing, so footage of a permanently dry track
    gets stretched until exposure drift and shadows read as a rain shower. The
    output looks convincing and is fabricated.

    So the dry end is measured from your footage — that is what absorbs camera,
    exposure, codec and daylight — and the wet end is derived from it by the
    offsets water actually produces. Percentile scaling is used only once the
    footage shows joint per-frame evidence of standing water.
    """
    arr = {k: np.array([getattr(s, k) for s in samples], dtype=np.float64) for k in KEYS}
    spread = {k: [float(v.min()), float(v.max())] for k, v in arr.items()}

    p = {
        k: {
            "min": float(v.min()),
            "lo": percentile(v, 0.10),
            "mid": percentile(v, 0.50),
            "hi": percentile(v, 0.90),
            "max": float(v.max()),
        }
        for k, v in arr.items()
    }

    # Joint, per frame. Any one of these alone is satisfied by dry tarmac in low
    # sun; only the combination separates water from glint.
    dark_threshold = p["darkness"]["lo"] + WET_EVIDENCE["darkness_above"]
    texture_threshold = p["texture"]["hi"] * WET_EVIDENCE["texture_below"]

    absolute = (arr["texture"] <= WET_ABSOLUTE["texture"]) & (arr["darkness"] >= WET_ABSOLUTE["darkness"])
    relative = (
        (arr["glare"] >= WET_EVIDENCE["glare"])
        & (arr["darkness"] >= dark_threshold)
        & (arr["texture"] <= texture_threshold)
    )
    wet_share = float((absolute | relative).mean())

    soaked = wet_share > WET_EVIDENCE["soaked_share"]
    has_wet = (not soaked) and wet_share >= WET_EVIDENCE["confident_share"]
    ambiguous = (not has_wet) and (not soaked) and wet_share > WET_EVIDENCE["none_share"]

    if soaked:
        branch = "wet-anchored"
        verdict = "wet throughout"
        # No dry running to measure, so the dry end is derived backwards.
        wet = {k: p[k]["mid"] for k in KEYS}
        dry = {
            "glare": max(0.0, wet["glare"] - WET_OFFSET["glare_add"]),
            "texture": wet["texture"] / WET_OFFSET["texture_ratio"],
            "darkness": max(0.0, wet["darkness"] - WET_OFFSET["darkness_add"]),
            "specular": max(0.0, wet["specular"] - WET_OFFSET["specular_add"]),
        }
        note = (
            f"Every frame reads wet ({wet_share:.0%}). The wet end is measured from your "
            f"footage and the dry end derived from it, which is the reverse of the usual "
            f"direction — load a dry clip as well to anchor both ends on measurement."
        )
    elif has_wet:
        branch = "measured-both-ends"
        verdict = "dry and wet both present"
        dry = {k: p[k]["lo"] if k != "texture" else p[k]["hi"] for k in KEYS}
        wet = {k: p[k]["hi"] if k != "texture" else p[k]["lo"] for k in KEYS}
        note = (
            f"{wet_share:.0%} of frames meet the joint wet test, so both ends are measured "
            f"from your footage. This is the strongest calibration available."
        )
    else:
        branch = "dry-anchored"
        verdict = "unproven" if ambiguous else "dry throughout"
        # Having concluded the footage is dry, the honest dry anchor is "the
        # wettest-looking thing in it is still dry" — the observed extreme, not
        # a percentile. Specular glare on real footage is bimodal, not spread:
        # on a dry lap most frames register no specular pixels at all while a
        # handful catching low sun reach 24%. A 90th-percentile dry anchor sits
        # at zero, every glinting frame lands past the wet end of the scale, and
        # a dry lap gets reported as Wet 94/100.
        dry = {
            "glare": p["glare"]["max"],
            "texture": p["texture"]["min"],
            "darkness": p["darkness"]["max"],
            "specular": p["specular"]["max"],
        }
        wet = {
            "glare": dry["glare"] + WET_OFFSET["glare_add"],
            "texture": dry["texture"] * WET_OFFSET["texture_ratio"],
            "darkness": dry["darkness"] + WET_OFFSET["darkness_add"],
            "specular": dry["specular"] + WET_OFFSET["specular_add"],
        }
        note = (
            (f"Only {wet_share:.0%} of frames show joint wet evidence — treated as unproven "
             f"and anchored conservatively as dry. ")
            if ambiguous else
            f"No wet track in this footage ({wet_share:.0%} of frames). "
        ) + "The dry end is measured; the wet end is derived from the physics of water on asphalt."

    return dry, wet, spread, branch, verdict, wet_share, note


def tracer_thresholds(stats: list[SurfaceStats]) -> dict:
    """Measure the lane tracer's own constants from the footage.

    These decide where the traced corridor stops, and they were picked against
    generated scenes — uniform grey roads, which real tarmac is not. Patched
    repairs, sun bleaching, rubbered-in racing lines and standing water all
    widen the distribution, and a tolerance set on a synthetic road clips the
    corridor on a real one.
    """
    sats = np.array([s.saturation for s in stats])
    lumas = np.array([s.luma for s in stats])

    # Admit almost all observed road saturation, with headroom — but never so
    # much that vegetation would pass. 0.45 is where grass starts on real
    # footage, so the ceiling sits below it whatever the measurement says.
    max_sat = float(min(0.42, max(0.18, percentile(sats, 0.98) * 1.35)))

    # Brightness spread between frames is a lower bound on the spread *within*
    # a frame, which is what the row-to-row tolerance has to survive.
    luma_spread = percentile(lumas, 0.95) - percentile(lumas, 0.05)
    luma_tolerance = float(min(90.0, max(30.0, luma_spread * 0.75)))

    return {
        "maxSat": round(max_sat, 4),
        "lumaTolerance": round(luma_tolerance, 1),
        "observed": {
            "saturation": {
                "p50": round(percentile(sats, 0.5), 4),
                "p98": round(percentile(sats, 0.98), 4),
                "max": round(float(sats.max()), 4),
            },
            "luma": {
                "p05": round(percentile(lumas, 0.05), 1),
                "p50": round(percentile(lumas, 0.5), 1),
                "p95": round(percentile(lumas, 0.95), 1),
            },
        },
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("clips", nargs="+", type=Path, help="video files to calibrate from")
    ap.add_argument("--out", type=Path, default=Path("calibration.json"))
    ap.add_argument("--every", type=int, default=10, help="sample every Nth frame")
    ap.add_argument("--max-frames", type=int, default=400, help="per clip")
    ap.add_argument("--width", type=int, default=960, help="downscale wider frames to this")
    ap.add_argument("--model", default=None, choices=sorted(REGISTRY),
                    help="use a segmentation model to find the road (recommended)")
    ap.add_argument("--models-dir", type=Path, default=MODELS_DIR)
    args = ap.parse_args(argv)

    missing = [c for c in args.clips if not c.exists()]
    if missing:
        print(f"no such file: {', '.join(str(m) for m in missing)}", file=sys.stderr)
        return 1

    if args.model:
        try:
            finder = SegmentationFinder(args.model, args.models_dir)
        except FileNotFoundError as err:
            print(f"\n{err}\n", file=sys.stderr)
            return 2
    else:
        finder = GeometricFinder()
        print("no --model given: using the geometric road finder. Install a segmentation "
              "model for a tighter region.\n", file=sys.stderr)

    print(f"finding the road with: {finder.name}\n", file=sys.stderr)

    all_stats: list[SurfaceStats] = []
    total_read = 0
    for clip in args.clips:
        stats, read = sample_clip(clip, finder, args.every, args.max_frames, args.width)
        all_stats.extend(stats)
        total_read += read

    if len(all_stats) < 25:
        print(
            f"\nOnly {len(all_stats)} frames yielded a road surface out of {total_read} read.\n"
            f"That is too few to calibrate from. Either the camera is not pointed at a track,\n"
            f"or the road finder cannot read this angle — check a frame against the overlay in\n"
            f"the app, and consider --model for a stronger finder.\n",
            file=sys.stderr,
        )
        return 1

    signals = [s.signals for s in all_stats]
    dry, wet, spread, branch, verdict, wet_share, note = anchors_from(signals)

    report = Report(
        clips=[str(c) for c in args.clips],
        frames_read=total_read,
        frames_measured=len(all_stats),
        road_found_share=round(len(all_stats) / max(1, total_read), 4),
        branch=branch,
        verdict=verdict,
        wet_share=round(wet_share, 4),
        dry={k: round(v, 6) for k, v in dry.items()},
        wet={k: round(v, 6) for k, v in wet.items()},
        spread={k: [round(a, 6), round(b, 6)] for k, (a, b) in spread.items()},
        tracer=tracer_thresholds(all_stats),
        note=note,
        generated_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        road_source=finder.name,
    )

    args.out.write_text(json.dumps(asdict(report), indent=2) + "\n")

    print(f"\n\033[1mCalibration written to {args.out}\033[0m\n", file=sys.stderr)
    print(f"  road found in       {report.road_found_share:.0%} of sampled frames "
          f"({report.frames_measured} of {report.frames_read})", file=sys.stderr)
    print(f"  verdict             {verdict}  [{branch}]", file=sys.stderr)
    print(f"  {note}\n", file=sys.stderr)
    print(f"  {'signal':<10} {'dry':>12} {'wet':>12}   observed range", file=sys.stderr)
    for k in KEYS:
        lo, hi = spread[k]
        print(f"  {k:<10} {dry[k]:>12.4f} {wet[k]:>12.4f}   {lo:.4f} … {hi:.4f}", file=sys.stderr)
    t = report.tracer
    print(f"\n  tracer maxSat       {t['maxSat']}   (road saturation p98 {t['observed']['saturation']['p98']})",
          file=sys.stderr)
    print(f"  tracer lumaTolerance {t['lumaTolerance']}   (road luma {t['observed']['luma']['p05']}"
          f"–{t['observed']['luma']['p95']})\n", file=sys.stderr)

    if report.road_found_share < 0.5:
        print("  \033[33mWARNING\033[0m: the road was found in under half the frames. These anchors\n"
              "  describe a biased sample — the frames where finding it was easy.\n", file=sys.stderr)

    print(f"  Load it in the app: Calibration & ROI → Import, or serve it at "
          f"/calibration.json\n", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
