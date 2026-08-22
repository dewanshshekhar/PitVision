#!/usr/bin/env python3
"""Bootstrap a training set from your footage without labelling it by hand.

    # 1. extract frames and pre-label them with the pretrained model
    python ml/scripts/prepare_dataset.py footage/*.mp4 --out dataset/ --model yolopv2

    # 2. open dataset/review/ and fix the ones that are wrong
    # 3. train
    python ml/scripts/finetune.py dataset/ --out ml/models/track.onnx

Why bootstrap rather than label
-------------------------------
Segmentation labels are expensive: a person drawing a road boundary produces
maybe forty frames an hour, and a useful fine-tune wants several hundred. That
cost is why most projects skip fine-tuning and live with a model that was
trained on something else.

The way around it is that the pretrained model is already mostly right. It finds
asphalt reliably — what it gets wrong on a circuit is specific and repetitive:
it includes run-off past the white line, it is unsure through spray, and it
loses the surface under heavy shadow. So it labels every frame, this script
sorts them by how confident it was, and a person spends their hour on the
hundred frames where it struggled rather than the four hundred where it did not.

Corrections go back as PNG masks. Anything you do not correct is used as-is,
which is safe precisely because those are the frames the model already handled.

Frame selection
---------------
Consecutive video frames are nearly identical, and a training set of near
duplicates teaches a network that one corner in one lighting condition is the
whole world. Frames are scored for how different they are from the ones already
chosen, and the most different are kept.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pitvision_ml.config import MODELS_DIR, REGISTRY, CorridorConfig  # noqa: E402
from pitvision_ml.corridor import corridor_from_masks  # noqa: E402


def frame_signature(frame: np.ndarray) -> np.ndarray:
    """A small descriptor for comparing frames cheaply.

    A downscaled, equalised greyscale thumbnail. Crude, and enough: the question
    is only "have I already got a frame that looks like this", not "are these
    the same place".
    """
    small = cv2.resize(frame, (32, 18), interpolation=cv2.INTER_AREA)
    grey = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    return cv2.equalizeHist(grey).astype(np.float32).ravel() / 255.0


def diversity_pick(
    candidates: list[tuple[np.ndarray, np.ndarray, float, str]],
    want: int,
) -> list[tuple[np.ndarray, np.ndarray, float, str]]:
    """Greedily keep the frames least like the ones already kept."""
    if len(candidates) <= want:
        return candidates

    sigs = [frame_signature(c[0]) for c in candidates]
    chosen = [0]
    dist = np.linalg.norm(np.array(sigs) - sigs[0], axis=1)

    while len(chosen) < want:
        nxt = int(np.argmax(dist))
        if dist[nxt] <= 0:
            break
        chosen.append(nxt)
        dist = np.minimum(dist, np.linalg.norm(np.array(sigs) - sigs[nxt], axis=1))

    return [candidates[i] for i in sorted(chosen)]


def overlay(frame: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Frame with the mask painted over it, for a human to judge at a glance."""
    tint = frame.copy()
    tint[mask > 0] = (0.45 * tint[mask > 0] + 0.55 * np.array([70, 220, 130])).astype(np.uint8)
    edges = cv2.Canny((mask > 0).astype(np.uint8) * 255, 50, 150)
    tint[edges > 0] = (255, 255, 255)
    return tint


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("clips", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--model", default=None, choices=sorted(REGISTRY),
                    help="pretrained model to pre-label with (strongly recommended)")
    ap.add_argument("--models-dir", type=Path, default=MODELS_DIR)
    ap.add_argument("--every", type=int, default=15, help="consider every Nth frame")
    ap.add_argument("--keep", type=int, default=400, help="frames to keep in total")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--review-count", type=int, default=120,
                    help="least-confident frames to copy into review/")
    args = ap.parse_args(argv)

    missing = [c for c in args.clips if not c.exists()]
    if missing:
        print(f"no such file: {', '.join(map(str, missing))}", file=sys.stderr)
        return 1

    if not args.model:
        print(
            "\n--model is required. Pre-labelling is the whole point: without it there is\n"
            "nothing to correct and you are labelling several hundred frames by hand.\n"
            "Install one first:\n\n"
            "    python ml/scripts/fetch_models.py --model yolopv2\n",
            file=sys.stderr,
        )
        return 1

    from pitvision_ml.segmenter import load  # noqa: PLC0415

    try:
        seg = load(args.model, args.models_dir)
    except FileNotFoundError as err:
        print(f"\n{err}\n", file=sys.stderr)
        return 2
    seg.warm_up(2)

    cfg = CorridorConfig()
    candidates: list[tuple[np.ndarray, np.ndarray, float, str]] = []

    for clip in args.clips:
        cap = cv2.VideoCapture(str(clip))
        if not cap.isOpened():
            print(f"could not open {clip}", file=sys.stderr)
            return 1
        idx = 0
        kept = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            idx += 1
            if idx % args.every:
                continue

            if frame.shape[1] > args.width:
                s = args.width / frame.shape[1]
                frame = cv2.resize(frame, (args.width, int(frame.shape[0] * s)),
                                   interpolation=cv2.INTER_AREA)

            out = seg.infer(frame)
            corr = corridor_from_masks(out.road, out.lane, cfg)
            mask = (out.road >= cfg.road_threshold).astype(np.uint8)
            # Confidence of the corridor, not of the raw mask: a mask can be
            # confidently wrong in a way that only shows once it has to become
            # a single connected corridor.
            conf = corr.confidence if corr else 0.0
            candidates.append((frame, mask, conf, f"{clip.stem}_{idx:06d}"))
            kept += 1
        cap.release()
        print(f"  {clip.name}: {kept} candidate frames", file=sys.stderr)

    if not candidates:
        print("no frames extracted", file=sys.stderr)
        return 1

    picked = diversity_pick(candidates, args.keep)
    print(f"\nkeeping {len(picked)} of {len(candidates)} candidates (most visually distinct)",
          file=sys.stderr)

    images = args.out / "images"
    masks = args.out / "masks"
    review = args.out / "review"
    for d in (images, masks, review):
        d.mkdir(parents=True, exist_ok=True)

    index = []
    for frame, mask, conf, name in picked:
        cv2.imwrite(str(images / f"{name}.png"), frame)
        cv2.imwrite(str(masks / f"{name}.png"), mask * 255)
        index.append({"name": name, "confidence": round(conf, 4)})

    # The least-confident frames are the ones worth a person's time.
    weakest = sorted(picked, key=lambda c: c[2])[: args.review_count]
    for frame, mask, conf, name in weakest:
        cv2.imwrite(str(review / f"{conf:.3f}_{name}.png"), overlay(frame, mask))

    (args.out / "index.json").write_text(json.dumps({
        "model": args.model,
        "clips": [str(c) for c in args.clips],
        "frames": index,
    }, indent=2) + "\n")

    print(f"""
  images   {images}   ({len(picked)} frames)
  masks    {masks}    (pre-labelled — edit these to correct)
  review   {review}   ({len(weakest)} lowest-confidence, mask painted on)

Next: flick through {review.name}/ — it is sorted worst-first, so the frames that
need attention are at the top. Where the green region is wrong, edit the matching
PNG in masks/ (white = road, black = not road) in any image editor. Everything you
leave alone is used as the model labelled it.

Then:  python ml/scripts/finetune.py {args.out} --out ml/models/track.onnx
""", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
