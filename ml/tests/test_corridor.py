"""Tests for the mask -> corridor conversion.

These are the tests that can be written honestly without weights, because the
conversion is a pure function of a mask. What they check is not "does the model
work" — that needs the real weights and real footage — but the thing that stands
between a plausible mask and a usable measurement region, which is where the
failures that produce confident wrong numbers actually live.

Every case here is a defect a real segmentation head produces:
a car punching a hole in the road, run-off beyond the white line that the model
was never taught to exclude, a second blob of asphalt across the infield, and a
mask that describes no road at all.

    .venv/bin/python -m pytest ml/tests -q
    .venv/bin/python ml/tests/test_corridor.py      # no pytest needed
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pitvision_ml.config import CorridorConfig
from pitvision_ml.corridor import corridor_from_masks

H, W = 288, 512
HORIZON = 0.34
CFG = CorridorConfig()

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


def section(title: str) -> None:
    print(f"\n\033[1m{title}\033[0m")


def track_edges(t: float, half: float = 0.10, flare: float = 0.30, bend: float = 0.0):
    """Racing surface boundaries at normalised depth `t` (0 far, 1 near)."""
    centre = 0.5 + bend * t * t
    w = half + flare * t
    return centre - w, centre + w


def build(
    *,
    bend: float = 0.0,
    runoff: float = 0.0,
    hole: tuple[float, float, float, float] | None = None,
    extra_blob: bool = False,
    lane_lines: bool = False,
):
    """Build a road probability map with the requested defects.

    `runoff` widens the drivable mask beyond the racing surface, which is what a
    BDD100K-trained head does on a circuit. `lane_lines` paints the white lines
    at the racing limits so the refinement has something to find.
    """
    road = np.zeros((H, W), dtype=np.float32)
    lane = np.zeros((H, W), dtype=np.float32) if lane_lines else None

    for y in range(H):
        ny = y / H
        if ny < HORIZON:
            continue
        t = (ny - HORIZON) / (1 - HORIZON)
        l, r = track_edges(t, bend=bend)
        # The mask the model returns: racing surface plus whatever run-off it
        # could not distinguish from it.
        ml_, mr = l - runoff * t, r + runoff * t
        road[y, max(0, int(ml_ * W)) : min(W, int(mr * W))] = 0.93

        if lane is not None:
            for x in (int(l * W), int(r * W)):
                lane[y, max(0, x - 2) : x + 3] = 0.9

    if hole is not None:
        x0, x1, y0, y1 = hole
        road[int(y0 * H) : int(y1 * H), int(x0 * W) : int(x1 * W)] = 0.02

    if extra_blob:
        # A slice of an adjacent straight visible across the infield: genuinely
        # asphalt, genuinely not the surface under the car.
        road[int(0.36 * H) : int(0.46 * H), int(0.02 * W) : int(0.26 * W)] = 0.95

    return road, lane


def truth_at(corr, i: int, bend: float = 0.0):
    ny = corr.y_top + (corr.y_bot - corr.y_top) * i / (CFG.rows - 1)
    t = max(0.0, min(1.0, (ny - HORIZON) / (1 - HORIZON)))
    return track_edges(t, bend=bend)


def boundary_error(corr, bend: float = 0.0, skip: int = 4) -> float:
    total, n = 0.0, 0
    for i in range(skip, CFG.rows - skip):
        l, r = truth_at(corr, i, bend)
        # The corridor is deliberately inset from the limits, so compare against
        # the truth inset by the same amount rather than against the raw edge.
        span = r - l
        inset = span * CFG.edge_inset
        total += abs(corr.left[i] - (l + inset)) + abs(corr.right[i] - (r - inset))
        n += 2
    return total / max(1, n)


# ── A clean mask ───────────────────────────────────────────────────────
section("A clean road mask")
road, _ = build()
corr = corridor_from_masks(road, None, CFG)
check("a corridor is produced", corr is not None)
if corr:
    check("boundaries land within 2% of the racing surface", boundary_error(corr) < 0.02,
          f"mean error {boundary_error(corr) * 100:.1f}%")
    check("every row is measured, none extrapolated", corr.confidence > 0.95,
          f"confidence {corr.confidence}")
    check("the corridor stops at the horizon", corr.y_top >= HORIZON - 0.02,
          f"yTop {corr.y_top:.3f}")
    check("it widens toward the camera",
          (corr.right[-1] - corr.left[-1]) > (corr.right[3] - corr.left[3]))

# ── A curve ────────────────────────────────────────────────────────────
section("A corner")
road, _ = build(bend=0.26)
corr = corridor_from_masks(road, None, CFG)
check("the corner is followed", corr is not None)
if corr:
    check("within 2.5% through the corner", boundary_error(corr, bend=0.26) < 0.025,
          f"mean error {boundary_error(corr, bend=0.26) * 100:.1f}%")
    near = (corr.left[-3] + corr.right[-3]) / 2
    far = (corr.left[4] + corr.right[4]) / 2
    check("the centre actually moves", abs(near - far) > 0.08, f"far {far:.2f} → near {near:.2f}")

# ── A car occluding the road ───────────────────────────────────────────
section("A car ahead punches a hole in the mask")
road, _ = build(hole=(0.40, 0.60, 0.60, 0.78))
corr = corridor_from_masks(road, None, CFG)
check("the corridor survives the hole", corr is not None)
if corr:
    check("the hole is bridged, not treated as an edge", boundary_error(corr) < 0.03,
          f"mean error {boundary_error(corr) * 100:.1f}%")
    check("the corridor still spans the full depth", corr.y_bot - corr.y_top > 0.55,
          f"span {corr.y_bot - corr.y_top:.2f}")

# ── A second patch of asphalt ──────────────────────────────────────────
section("Asphalt across the infield is not the road we are on")
road, _ = build(extra_blob=True)
corr = corridor_from_masks(road, None, CFG)
check("a corridor is still produced", corr is not None)
if corr:
    check("the far blob is excluded", boundary_error(corr) < 0.03,
          f"mean error {boundary_error(corr) * 100:.1f}%")
    check("the corridor never reaches the blob's column range",
          min(corr.left) > 0.10, f"leftmost {min(corr.left):.3f}")

# ── The race-track correction ──────────────────────────────────────────
section("Run-off is excluded when the white line is visible")
# The model over-reports by 12% of frame width at the near end — what a
# public-road head does on a circuit, where run-off is asphalt too.
road, lane = build(runoff=0.12, lane_lines=True)

without = corridor_from_masks(road, None, CFG)
with_lines = corridor_from_masks(road, lane, CFG)

check("both produce a corridor", without is not None and with_lines is not None)
if without and with_lines:
    err_without = boundary_error(without)
    err_with = boundary_error(with_lines)
    check("the mask alone over-reports the racing surface", err_without > 0.03,
          f"error {err_without * 100:.1f}%")
    check("lane markings pull the limits back in", err_with < err_without * 0.6,
          f"{err_without * 100:.1f}% → {err_with * 100:.1f}%")
    check("and the result is close to the true limits", err_with < 0.025,
          f"error {err_with * 100:.1f}%")
    check("the report says where the limits came from",
          with_lines.limits_from == "lane_markings" and without.limits_from == "mask_edge",
          f"{with_lines.limits_from} / {without.limits_from}")

# ── Refusal ────────────────────────────────────────────────────────────
section("It refuses rather than inventing a road")
check("an empty mask returns nothing",
      corridor_from_masks(np.zeros((H, W), dtype=np.float32), None, CFG) is None)
check("a mask of pure noise returns nothing",
      corridor_from_masks(np.full((H, W), 0.3, dtype=np.float32), None, CFG) is None)

speckle = np.zeros((H, W), dtype=np.float32)
rng = np.random.default_rng(7)
speckle[rng.random((H, W)) > 0.985] = 0.99
check("scattered speckle returns nothing", corridor_from_masks(speckle, None, CFG) is None)

sliver = np.zeros((H, W), dtype=np.float32)
sliver[int(0.5 * H) :, int(0.49 * W) : int(0.51 * W)] = 0.99
check("a sliver too narrow to measure returns nothing",
      corridor_from_masks(sliver, None, CFG) is None)

# ── The contract the browser depends on ────────────────────────────────
section("The wire shape matches what the browser consumes")
road, _ = build()
corr = corridor_from_masks(road, None, CFG)
if corr:
    j = corr.to_json()
    check("keys match LaneTrace",
          set(j) >= {"yTop", "yBot", "left", "right", "confidence", "meanWidth"})
    check(f"left/right carry exactly {CFG.rows} rows",
          len(j["left"]) == CFG.rows and len(j["right"]) == CFG.rows)
    check("all coordinates are normalised into [0,1]",
          all(0.0 <= v <= 1.0 for v in j["left"] + j["right"]))
    check("left is never right of right",
          all(l <= r for l, r in zip(j["left"], j["right"])))
    check("it is JSON-serialisable", __import__("json").dumps(j) is not None)

_colour = "\033[32m" if _failed == 0 else "\033[31m"
print(f"\n{_colour}{_passed} passed, {_failed} failed\033[0m\n")
sys.exit(1 if _failed else 0)
