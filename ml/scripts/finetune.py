#!/usr/bin/env python3
"""Fine-tune a road segmenter on your own circuit.

    python ml/scripts/finetune.py dataset/ --out ml/models/track.onnx

Needs PyTorch. It is a setup-time dependency only — the result is an ONNX file,
and the garage machine runs that with `onnxruntime` and nothing else.

    pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu

What this fixes
---------------
A model trained on BDD100K knows what a public road looks like. A circuit
differs in ways that are consistent, and therefore learnable from a few hundred
frames:

  - Run-off is asphalt, so a drivable-area head includes it. The racing surface
    ends at the white line. This is the single biggest error and the one that
    matters most, because measuring the run-off drags the edge bands toward a
    surface nobody is racing on — and the gap between the edges and the racing
    line *is* the dry-line call.
  - Kerbs are red-and-white rumble strips rather than urban granite.
  - There are no junctions, pavements, parked cars or road markings in the
    urban sense.

Why a small model trained from your data, rather than adapting the big one
-------------------------------------------------------------------------
The pretrained network's value here is not its weights, it is its *labels*: it
has already told you where the road is in every frame you gave it, and you have
corrected the ones it got wrong. Training a compact U-Net on that is a few
minutes on a CPU and produces a single-purpose model that runs several times
faster than the multi-task network it learned from — which matters, because this
runs beside a pipeline with a 100 ms budget.

It also keeps the licences clean: the output is your model trained on your
footage, not a redistribution of someone else's weights.

Honest limits
-------------
Trained on one circuit in one set of conditions, it will be excellent there and
worse elsewhere. That is the correct trade for a team that races the same
calendar, and the wrong one for a general-purpose detector. Keep the pretrained
model installed as the fallback — the sidecar will use whichever is configured,
and the geometric tracer is underneath both.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

TORCH_HELP = """
This script needs PyTorch, which the inference side deliberately does not.

    pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu

Training a few hundred frames on CPU takes minutes, so a GPU is convenient
rather than necessary.
"""


def require_torch():
    try:
        import torch  # noqa: PLC0415
        import torch.nn as nn  # noqa: PLC0415
        return torch, nn
    except ImportError:
        raise SystemExit(TORCH_HELP) from None


def build_unet(nn):
    """A small U-Net. Single output channel: road or not road.

    Deliberately modest — around 0.5M parameters. The dataset is a few hundred
    frames of one circuit, and a larger network on that much data memorises the
    frames rather than learning the surface.
    """

    def block(cin, cout):
        return nn.Sequential(
            nn.Conv2d(cin, cout, 3, padding=1, bias=False),
            nn.BatchNorm2d(cout),
            nn.ReLU(inplace=True),
            nn.Conv2d(cout, cout, 3, padding=1, bias=False),
            nn.BatchNorm2d(cout),
            nn.ReLU(inplace=True),
        )

    class UNet(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.d1, self.d2, self.d3, self.d4 = block(3, 24), block(24, 48), block(48, 96), block(96, 128)
            self.pool = nn.MaxPool2d(2)
            self.up3 = nn.ConvTranspose2d(128, 96, 2, stride=2)
            self.u3 = block(192, 96)
            self.up2 = nn.ConvTranspose2d(96, 48, 2, stride=2)
            self.u2 = block(96, 48)
            self.up1 = nn.ConvTranspose2d(48, 24, 2, stride=2)
            self.u1 = block(48, 24)
            self.head = nn.Conv2d(24, 1, 1)

        def forward(self, x):
            import torch  # noqa: PLC0415
            c1 = self.d1(x)
            c2 = self.d2(self.pool(c1))
            c3 = self.d3(self.pool(c2))
            c4 = self.d4(self.pool(c3))
            x = self.u3(torch.cat([self.up3(c4), c3], 1))
            x = self.u2(torch.cat([self.up2(x), c2], 1))
            x = self.u1(torch.cat([self.up1(x), c1], 1))
            # A logit, not a probability. `segmenter._to_prob` detects which it
            # got and applies the sigmoid, so both conventions load correctly.
            return self.head(x)

    return UNet()


def load_dataset(root: Path, size: tuple[int, int]):
    """Read image/mask pairs, resized to the training resolution."""
    import cv2  # noqa: PLC0415

    images_dir, masks_dir = root / "images", root / "masks"
    if not images_dir.is_dir() or not masks_dir.is_dir():
        raise SystemExit(
            f"\n{root} does not look like a prepared dataset — expected images/ and masks/.\n"
            f"Build one first:\n\n"
            f"    python ml/scripts/prepare_dataset.py <clips> --out {root} --model yolopv2\n"
        )

    h, w = size
    xs, ys, names = [], [], []
    for img_path in sorted(images_dir.glob("*.png")):
        mask_path = masks_dir / img_path.name
        if not mask_path.exists():
            continue
        img = cv2.imread(str(img_path), cv2.IMREAD_COLOR)
        msk = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
        if img is None or msk is None:
            continue
        img = cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA)
        msk = cv2.resize(msk, (w, h), interpolation=cv2.INTER_NEAREST)
        xs.append(cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32).transpose(2, 0, 1) / 255.0)
        ys.append((msk > 127).astype(np.float32)[None])
        names.append(img_path.stem)

    if not xs:
        raise SystemExit(f"no image/mask pairs found under {root}")
    return np.stack(xs), np.stack(ys), names


def augment(x: np.ndarray, y: np.ndarray, rng: np.random.Generator):
    """Flips and photometric jitter.

    Weather is the axis that matters and the one a single session's footage has
    least of, so brightness and contrast are jittered hard: a model that has
    only seen an overcast Friday should still find the road in Sunday sunshine.
    Geometric augmentation stays mild — the camera is bolted down, and teaching
    invariance to rotations it will never see spends capacity for nothing.
    """
    if rng.random() < 0.5:
        x, y = x[..., ::-1].copy(), y[..., ::-1].copy()
    gain = float(rng.uniform(0.65, 1.4))
    bias = float(rng.uniform(-0.14, 0.14))
    x = np.clip(x * gain + bias, 0.0, 1.0)
    if rng.random() < 0.3:
        x = np.clip(x + rng.normal(0, 0.025, x.shape).astype(np.float32), 0.0, 1.0)
    return x, y


def dice_loss(pred, target, eps: float = 1.0):
    """Dice, paired with BCE by the caller.

    BCE alone is dominated by the large easy interior of the road and barely
    penalises a boundary that is a few per cent out. The boundary is the entire
    product here — it is what separates racing surface from run-off — so Dice
    is added to weight overlap rather than per-pixel accuracy.
    """
    import torch  # noqa: PLC0415

    p = torch.sigmoid(pred)
    num = 2 * (p * target).sum(dim=(1, 2, 3)) + eps
    den = p.sum(dim=(1, 2, 3)) + target.sum(dim=(1, 2, 3)) + eps
    return (1 - num / den).mean()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dataset", type=Path)
    ap.add_argument("--out", type=Path, default=Path("ml/models/track.onnx"))
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--height", type=int, default=256)
    ap.add_argument("--width", type=int, default=448)
    ap.add_argument("--val-split", type=float, default=0.15)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args(argv)

    torch, nn = require_torch()
    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)

    X, Y, names = load_dataset(args.dataset, (args.height, args.width))
    print(f"  {len(X)} frames at {args.width}x{args.height}", file=sys.stderr)

    # Split by index order, which after prepare_dataset's diversity pick is not
    # time order — so validation is not simply the end of one clip.
    idx = rng.permutation(len(X))
    n_val = max(2, int(len(X) * args.val_split))
    val_idx, train_idx = idx[:n_val], idx[n_val:]
    print(f"  {len(train_idx)} train / {len(val_idx)} validation", file=sys.stderr)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"  device: {device}", file=sys.stderr)

    model = build_unet(nn).to(device)
    params = sum(p.numel() for p in model.parameters())
    print(f"  {params / 1e6:.2f}M parameters\n", file=sys.stderr)

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
    bce = nn.BCEWithLogitsLoss()

    xv = torch.from_numpy(X[val_idx]).to(device)
    yv = torch.from_numpy(Y[val_idx]).to(device)

    best_iou = -1.0
    best_state = None
    started = time.time()

    for epoch in range(args.epochs):
        model.train()
        order = rng.permutation(train_idx)
        total = 0.0
        for i in range(0, len(order), args.batch):
            batch = order[i : i + args.batch]
            xb = np.stack([augment(X[j], Y[j], rng)[0] for j in batch])
            yb = np.stack([augment(X[j], Y[j], rng)[1] for j in batch])
            xb = torch.from_numpy(xb).to(device)
            yb = torch.from_numpy(yb).to(device)

            opt.zero_grad(set_to_none=True)
            pred = model(xb)
            loss = bce(pred, yb) + dice_loss(pred, yb)
            loss.backward()
            opt.step()
            total += float(loss) * len(batch)
        sched.step()

        model.eval()
        with torch.no_grad():
            pv = torch.sigmoid(model(xv)) > 0.5
            tv = yv > 0.5
            inter = (pv & tv).sum().item()
            union = (pv | tv).sum().item()
            iou = inter / max(1, union)

        marker = ""
        if iou > best_iou:
            best_iou = iou
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
            marker = "  ← best"
        print(f"  epoch {epoch + 1:3d}/{args.epochs}  loss {total / len(order):.4f}  "
              f"val IoU {iou:.4f}{marker}", file=sys.stderr)

    print(f"\n  best validation IoU {best_iou:.4f} in {time.time() - started:.0f}s", file=sys.stderr)

    if best_iou < 0.75:
        print(
            f"\n  \033[33mWARNING\033[0m: {best_iou:.2f} IoU is low. Usually one of:\n"
            f"    - too few frames (aim for 300+ spanning different light and weather)\n"
            f"    - inconsistent corrections, so the same surface is labelled both ways\n"
            f"    - the frames are near-duplicates, so validation is memorised\n"
            f"  A model below ~0.75 is not worth installing over the pretrained one.\n",
            file=sys.stderr,
        )

    model.load_state_dict(best_state)
    model.eval()

    args.out.parent.mkdir(parents=True, exist_ok=True)
    dummy = torch.zeros(1, 3, args.height, args.width, device=device)
    torch.onnx.export(
        model, dummy, str(args.out),
        input_names=["images"], output_names=["road_logit"],
        opset_version=17, do_constant_folding=True, dynamo=False,
    )

    meta = args.out.with_suffix(".json")
    meta.write_text(json.dumps({
        "adapter": "single",
        "input_size": [args.height, args.width],
        "val_iou": round(best_iou, 4),
        "frames": len(X),
        "epochs": args.epochs,
        "dataset": str(args.dataset),
        "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }, indent=2) + "\n")

    print(f"\n  wrote {args.out} ({args.out.stat().st_size >> 10} KiB) and {meta.name}\n"
          f"\n  Verify it before trusting it:\n"
          f"    python ml/scripts/fetch_models.py --model yolopv2 --from-file {args.out}\n",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
