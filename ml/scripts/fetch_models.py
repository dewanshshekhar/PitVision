#!/usr/bin/env python3
"""Fetch, export and verify a road-segmentation model.

Run this once, on a machine that can reach GitHub. The result is a single
`.onnx` file in `ml/models/` that the sidecar loads; after that the garage
machine needs no network and no PyTorch.

    python ml/scripts/fetch_models.py --model yolopv2
    python ml/scripts/fetch_models.py --model twinlitenet
    python ml/scripts/fetch_models.py --model yolopv2 --from-file ./yolopv2.pt

Why it resolves rather than hardcodes
-------------------------------------
Release asset URLs move: repositories retag, rename files, and switch between
release attachments and LFS. A hardcoded URL that has quietly 404'd is worse
than no URL, because it fails on the day someone is setting up in a garage with
a race starting. So the script asks the GitHub releases API what assets actually
exist and picks one, and `--from-file` always works when the network does not.

Why it verifies
---------------
A downloaded file is not a working model. The export can succeed and produce a
graph whose outputs are transposed, whose input is NHWC, or whose segmentation
head is a logit where the code expects a probability — none of which raise, all
of which produce a plausible-looking mask that is wrong. So the last step runs
the finished ONNX through the same code path the sidecar uses, on a frame with a
known road in it, and refuses to install a model that cannot find it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pitvision_ml.config import MODELS_DIR, REGISTRY, CorridorConfig, ModelSpec  # noqa: E402
from pitvision_ml.corridor import corridor_from_masks  # noqa: E402
from pitvision_ml.segmenter import RoadSegmenter  # noqa: E402

#: Where each model's weights live, and how to recognise the right asset.
SOURCES: dict[str, dict] = {
    "yolopv2": {
        "repo": "CAIC-AD/YOLOPv2",
        "prefer": [".onnx"],
        "accept": [".onnx", ".pt"],
        "input_size": (384, 640),
        "licence": "MIT",
    },
    "twinlitenet": {
        "repo": "chequanghuy/TwinLiteNet",
        "prefer": [".onnx"],
        "accept": [".onnx", ".pth", ".pt"],
        "input_size": (360, 640),
        "licence": "see repository",
    },
}


def log(msg: str) -> None:
    print(f"  {msg}", file=sys.stderr)


def list_release_assets(repo: str) -> list[dict]:
    """Ask GitHub what is actually published, rather than guessing a filename."""
    url = f"https://api.github.com/repos/{repo}/releases"
    req = urllib.request.Request(url, headers={"accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=30) as res:
        releases = json.loads(res.read())

    assets: list[dict] = []
    for release in releases:
        for asset in release.get("assets", []):
            assets.append({
                "name": asset["name"],
                "url": asset["browser_download_url"],
                "size": asset.get("size", 0),
                "tag": release.get("tag_name", "?"),
            })
    return assets


def pick_asset(assets: list[dict], prefer: list[str], accept: list[str]) -> dict | None:
    for ext in prefer + [e for e in accept if e not in prefer]:
        matches = [a for a in assets if a["name"].lower().endswith(ext)]
        if matches:
            # Largest is the full model rather than a demo clip or a config.
            return max(matches, key=lambda a: a["size"])
    return None


def download(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    log(f"downloading {url}")

    req = urllib.request.Request(url, headers={"user-agent": "pitvision-fetch"})
    with urllib.request.urlopen(req, timeout=300) as res, tmp.open("wb") as out:
        total = int(res.headers.get("content-length") or 0)
        done = 0
        while chunk := res.read(1 << 20):
            out.write(chunk)
            done += len(chunk)
            if total:
                pct = done * 100 // total
                print(f"\r    {pct:3d}%  {done >> 20} / {total >> 20} MiB", end="", file=sys.stderr)
    print("", file=sys.stderr)

    tmp.replace(dest)
    return dest


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def export_to_onnx(weights: Path, dest: Path, input_size: tuple[int, int]) -> Path:
    """Convert a PyTorch or TorchScript checkpoint to ONNX.

    Only needed when the project does not publish an ONNX build. PyTorch is
    imported here and nowhere else, so it stays a one-off setup dependency
    rather than something the garage machine has to carry.
    """
    try:
        import torch  # noqa: PLC0415 - deliberately local
    except ImportError:
        raise SystemExit(
            f"\n{weights.name} is a PyTorch checkpoint and must be converted to ONNX.\n"
            f"That step needs PyTorch:\n\n"
            f"    pip install torch --index-url https://download.pytorch.org/whl/cpu\n\n"
            f"Then run this command again. Alternatively, export it on any machine that\n"
            f"has PyTorch and copy the .onnx here with --from-file.\n"
        ) from None

    log(f"loading {weights.name} with torch {torch.__version__}")
    model = torch.jit.load(str(weights), map_location="cpu") if weights.suffix == ".pt" \
        else torch.load(str(weights), map_location="cpu", weights_only=False)
    model.eval()

    h, w = input_size
    dummy = torch.zeros(1, 3, h, w)
    log(f"exporting to ONNX at {w}x{h}")
    torch.onnx.export(
        model,
        dummy,
        str(dest),
        input_names=["images"],
        opset_version=17,
        do_constant_folding=True,
        dynamo=False,
    )
    return dest


def verification_frame(w: int = 768, h: int = 432) -> np.ndarray:
    """A frame with a road in a known place, in BGR.

    Crude on purpose. This does not measure accuracy — it asks whether the
    installed graph produces a road-shaped mask at all, which is the question
    that separates a working export from a subtly broken one.
    """
    frame = np.zeros((h, w, 3), dtype=np.uint8)
    frame[: int(0.36 * h)] = (225, 165, 120)
    rng = np.random.default_rng(0)
    for y in range(int(0.36 * h), h):
        t = (y / h - 0.36) / 0.64
        half = 0.08 + 0.30 * t
        l, r = int((0.5 - half) * w), int((0.5 + half) * w)
        frame[y, :l] = (44, 104, 58)
        frame[y, r:] = (44, 104, 58)
        noise = rng.integers(-12, 12, size=(r - l, 1))
        frame[y, l:r] = np.clip(118 + noise, 0, 255)
    return frame


def verify(onnx_path: Path, spec: ModelSpec) -> bool:
    """Run the installed model the way the sidecar will, and check the result."""
    log("verifying the installed model")
    try:
        seg = RoadSegmenter(onnx_path, spec)
    except Exception as err:  # noqa: BLE001
        log(f"FAILED: the ONNX graph would not load — {err}")
        return False

    log(f"  input {seg.input_size}, providers {seg.providers}")
    warm = seg.warm_up(2)
    log(f"  warm inference {warm:.0f} ms")

    frame = verification_frame()
    try:
        out = seg.infer(frame)
    except Exception as err:  # noqa: BLE001
        log(f"FAILED: inference raised — {type(err).__name__}: {err}")
        return False

    coverage = float((out.road > 0.5).mean())
    log(f"  road coverage {coverage:.3f}")

    ok = True
    if not (0.05 < coverage < 0.85):
        log(f"FAILED: road head covers {coverage:.1%} of the frame. Outside 5–85% means the "
            f"head is inverted, saturated, or is not the road head.")
        ok = False

    sky = float((out.road[: int(0.30 * frame.shape[0])] > 0.5).mean())
    if sky > 0.25:
        log(f"FAILED: {sky:.1%} of the sky is called road. The output is probably transposed "
            f"or the heads are swapped.")
        ok = False

    corr = corridor_from_masks(out.road, out.lane, CorridorConfig())
    if corr is None:
        log("FAILED: no corridor could be built from the mask.")
        ok = False
    else:
        log(f"  corridor {corr.y_top:.2f}–{corr.y_bot:.2f}, confidence {corr.confidence:.2f}, "
            f"limits from {corr.limits_from}")
        if corr.confidence < 0.6:
            log(f"WARNING: corridor confidence {corr.confidence:.2f} on a clean synthetic frame. "
                f"Usable, but check the overlay carefully on real footage.")

    return ok


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default="yolopv2", choices=sorted(SOURCES))
    ap.add_argument("--models-dir", type=Path, default=MODELS_DIR)
    ap.add_argument("--from-file", type=Path, help="Use a local .onnx/.pt instead of downloading")
    ap.add_argument("--list", action="store_true", help="List published assets and exit")
    ap.add_argument("--force", action="store_true", help="Re-download even if a model is installed")
    args = ap.parse_args(argv)

    spec = REGISTRY[args.model]
    source = SOURCES[args.model]
    dest = args.models_dir / spec.filename

    print(f"\n{args.model} — {spec.notes}\n  source: {spec.source}  licence: {source['licence']}\n",
          file=sys.stderr)

    if args.list:
        try:
            for a in list_release_assets(source["repo"]):
                print(f"  {a['tag']:<12} {a['name']:<40} {a['size'] >> 20:>5} MiB\n    {a['url']}")
        except urllib.error.URLError as err:
            print(f"could not reach GitHub: {err}", file=sys.stderr)
            return 1
        return 0

    if dest.exists() and not args.force:
        log(f"{dest} already present — verifying it rather than re-downloading (--force to replace)")
        return 0 if verify(dest, spec) else 1

    work = args.models_dir / "_download"
    work.mkdir(parents=True, exist_ok=True)

    if args.from_file:
        if not args.from_file.exists():
            print(f"no such file: {args.from_file}", file=sys.stderr)
            return 1
        raw = work / args.from_file.name
        shutil.copy2(args.from_file, raw)
        log(f"using local {args.from_file}")
    else:
        try:
            assets = list_release_assets(source["repo"])
        except urllib.error.URLError as err:
            print(
                f"\nCould not reach GitHub: {err}\n\n"
                f"If this machine has no route to GitHub, download the weights elsewhere from\n"
                f"  {spec.source}\n"
                f"and install them with:\n"
                f"  python ml/scripts/fetch_models.py --model {args.model} --from-file <path>\n",
                file=sys.stderr,
            )
            return 1

        if not assets:
            print(f"\n{source['repo']} publishes no release assets. Download the weights by hand\n"
                  f"from {spec.source} and pass them with --from-file.\n", file=sys.stderr)
            return 1

        chosen = pick_asset(assets, source["prefer"], source["accept"])
        if not chosen:
            print(f"\nNo asset matching {source['accept']} in:\n", file=sys.stderr)
            for a in assets:
                print(f"  {a['name']}", file=sys.stderr)
            print(f"\nUse --list to inspect, then --from-file to install one by hand.\n",
                  file=sys.stderr)
            return 1

        log(f"selected {chosen['name']} from release {chosen['tag']} ({chosen['size'] >> 20} MiB)")
        raw = download(chosen["url"], work / chosen["name"])

    log(f"sha256 {sha256(raw)}")

    if raw.suffix.lower() == ".onnx":
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(raw, dest)
    else:
        export_to_onnx(raw, dest, source["input_size"])

    if not verify(dest, spec):
        # A model that fails verification must not be left where the sidecar
        # would load it — a broken model that runs is worse than a missing one,
        # because the missing one falls back to the geometric tracer.
        broken = dest.with_suffix(".onnx.rejected")
        dest.replace(broken)
        print(f"\nVerification failed. The file has been moved to {broken} rather than installed,\n"
              f"so the detector falls back to the geometric tracer instead of trusting it.\n",
              file=sys.stderr)
        return 1

    print(f"\ninstalled {dest} ({dest.stat().st_size >> 20} MiB)\n"
          f"start the sidecar with:  python -m pitvision_ml.service --model {args.model}\n",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
