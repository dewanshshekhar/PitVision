# Road segmentation

Optional. The detector works without any of this — the in-browser geometric
tracer finds the road in half a millisecond and needs no Python, no model and no
network. What this adds is a network trained on real driving footage, which
finds the road through spray, at night, and across patched and rubbered-in
tarmac far more reliably than a heuristic can.

Three sources, each falling back to the next, so nothing here can leave the
detector without a region to measure:

| | Where it runs | Cost | Needs |
|---|---|---|---|
| **Segmentation** | Python sidecar | ~30–80 ms, up to 8×/s | a model file |
| **Geometric tracing** | browser | 0.42 ms, up to 16×/s | nothing |
| **Hand-placed ROI** | browser | free | someone to aim it |

---

## Setup

```bash
python -m venv .venv && .venv/bin/pip install -r ml/requirements.txt

# once, on a machine that can reach GitHub
python ml/scripts/fetch_models.py --model yolopv2

# then, beside the Node backend
PYTHONPATH=ml python -m pitvision_ml.service --model yolopv2
PITVISION_SEGMENTER_URL=http://127.0.0.1:8788 npm start
```

No PyTorch on the race machine. The model arrives as ONNX and ONNX Runtime
executes it — a 25 MB wheel rather than a 900 MB one, and the same file runs on
CPU, CUDA, OpenVINO or an NPU without a code change.

---

## Which model

Both are trained on **BDD100K** — 100k real driving videos spanning rain, night,
glare and overcast. That is the reason for choosing them over anything trained
on clean daytime footage: the conditions this project exists to measure are
exactly the conditions that break a model trained on easy data.

| | Heads | Size | Use when |
|---|---|---|---|
| [YOLOPv2](https://github.com/CAIC-AD/YOLOPv2) | detection, drivable area, lane lines | ~8M params | accuracy matters; 0.93 mIoU drivable area on BDD100K |
| [TwinLiteNet](https://github.com/chequanghuy/TwinLiteNet) | drivable area, lane lines | ~0.4M params | the garage laptop is doing three other things |

### The domain gap, stated plainly

BDD100K is public roads. A circuit differs in ways that matter:

- **Run-off is asphalt**, so a drivable-area head includes it. The racing
  surface ends at the white line, not where the tarmac does. This is the single
  biggest error and the one that matters most, because measuring the run-off
  drags the edge bands toward a surface nobody is racing on — and the gap
  between the edges and the racing line *is* the dry-line call.
- Kerbs are red-and-white rumble strips, not urban granite.
- There are no junctions, pavements or urban lane markings.

Out of the box these models find the tarmac. `corridor.py` recovers the racing
limits from the lane-line head where the paint is visible, and reports
`limitsFrom` so a reading can be trusted with the right amount of confidence.
Fine-tuning closes the rest of the gap.

---

## Calibrating on your own footage — do this first

```bash
python ml/scripts/calibrate.py footage/*.mp4 --out calibration.json --model yolopv2
```

This is the step that replaces guessed constants with measured ones, and it
needs no labels and no training.

**The tracer's own thresholds were never measured.** How colourless asphalt is,
and how far its brightness drifts row to row, decide where the traced corridor
stops. Those were chosen against generated scenes — uniform grey roads, which
real tarmac is not.

**Race day should not start with a calibration.** The browser can anchor itself
from a live feed in about fifteen seconds. That is fine for a practice session
and not fine for the moment the lights go out. Run this the day before on last
year's footage, or on this morning's installation lap, and the app starts
already anchored: copy `calibration.json` into `public/` and it is imported at
startup as the pre-warm seed, then refined live once real footage loads.

The two ends of the scale are established differently, and the asymmetry is
deliberate. Mapping the clip's own percentiles to 0 and 100 is the obvious
implementation and it is wrong: a purely relative scale *always* yields a full
swing, so footage of a permanently dry track gets stretched until exposure drift
reads as a rain shower. So the dry end is measured from your footage and the wet
end derived from what water actually does to asphalt — unless the footage shows
joint per-frame evidence of standing water, in which case both ends are
measured. The report says which branch ran.

---

## Fine-tuning on your circuit

```bash
python ml/scripts/prepare_dataset.py footage/*.mp4 --out dataset/ --model yolopv2
# review dataset/review/ — sorted worst-first — and correct the masks that are wrong
python ml/scripts/finetune.py dataset/ --out ml/models/track.onnx
```

Labels are the expensive part: a person drawing road boundaries produces maybe
forty frames an hour, and a useful fine-tune wants several hundred. So the
pretrained model labels every frame, `prepare_dataset.py` sorts them by how
confident it was, and you spend your hour on the hundred it struggled with
rather than the four hundred it got right.

`finetune.py` trains a compact U-Net on the result. That is deliberate: the
pretrained network's value here is its *labels*, not its weights. A single-purpose
model trained on your corrected masks runs several times faster than the
multi-task network it learned from — which matters beside a 100 ms budget — and
the output is your model trained on your footage rather than a redistribution of
someone else's weights.

Trained on one circuit in one set of conditions it will be excellent there and
worse elsewhere. That is the right trade for a team racing the same calendar and
the wrong one for a general detector, so keep the pretrained model installed as
the fallback.

---

## Tests

```bash
.venv/bin/python ml/tests/test_corridor.py    # mask -> corridor
.venv/bin/python ml/tests/test_segmenter.py   # ONNX inference path
.venv/bin/python ml/tests/test_service.py     # HTTP contract
.venv/bin/python ml/tests/test_calibrate.py   # anchoring branches
```

They run without the pretrained weights, against a real ONNX graph built by
`tests/make_fixture_model.py` with the same input signature and output layout.
That covers everything between a frame arriving and a corridor coming out —
letterboxing, head identification, coordinate round-trip, hole bridging,
run-off exclusion, refusal.

It does **not** cover whether a network can find a road. That needs the real
weights and real footage, and no fixture stands in for it.

The cases in `test_corridor.py` are the defects a real segmentation head
produces: a car punching a hole in the road, run-off beyond the white line, a
second blob of asphalt across the infield, a mask describing no road at all.
Those are where the failures that produce confident wrong numbers live.

---

## Layout

```
ml/
  pitvision_ml/
    config.py       model registry, thresholds, every one with a reason
    segmenter.py    ONNX session, letterboxing, per-model output adapters
    corridor.py     mask -> corridor: the core CV, and where most of the work is
    signals.py      the four surface signals, ported from src/cv/metrics.ts
    service.py      the HTTP sidecar
  scripts/
    fetch_models.py     download, export, and verify before installing
    calibrate.py        real footage -> anchors + tracer thresholds
    prepare_dataset.py  pseudo-label bootstrap
    finetune.py         train on your circuit
  tests/
```
