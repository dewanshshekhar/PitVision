"""Turn a segmentation mask into a corridor the detector can measure through.

This is the part that decides whether a neural road mask is usable, and it is
where most of the real work is. A segmentation head returns a probability map,
not a road: it has holes where a car occludes the surface, blobs of stray
confidence on a parallel carriageway or a wet reflection, and — on a race track
— it happily includes the asphalt run-off beyond the white line, because the
model was trained on public roads where run-off does not exist.

Feeding that mask straight to the sampler would be worse than the geometric
tracer it replaces. What comes out of here has to be a single connected road
surface, bounded at the racing limits, expressed as the same per-row corridor
the browser already consumes, so nothing downstream needs to know which of the
two produced it.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any

import cv2
import numpy as np

from .config import CorridorConfig


@dataclass
class Corridor:
    """The same shape `LaneTrace` has in src/cv/lane.ts.

    Kept identical on purpose: the browser drops this into `corridorFromTrace`
    without a translation layer, so the neural path and the geometric path go
    through exactly one piece of measurement code and cannot disagree about
    what a corridor means.
    """

    y_top: float
    y_bot: float
    left: list[float]
    right: list[float]
    confidence: float
    measured_rows: int
    mean_width: float
    #: Which boundary won: the mask edge, or a lane marking inside it.
    limits_from: str
    source: str = "segmentation"

    def to_json(self) -> dict[str, Any]:
        d = asdict(self)
        return {
            "yTop": d["y_top"],
            "yBot": d["y_bot"],
            "left": d["left"],
            "right": d["right"],
            "confidence": d["confidence"],
            "measuredRows": d["measured_rows"],
            "meanWidth": d["mean_width"],
            "limitsFrom": d["limits_from"],
            "source": d["source"],
        }


def _largest_component_containing_ego(mask: np.uint8, ego_x: float = 0.5) -> np.ndarray:
    """Keep the one road blob the camera is actually on.

    A drivable-area head on a race track returns several regions: the track, the
    run-off across a kerb, and often a slice of an adjacent straight visible
    across the infield. They are all genuinely asphalt, so no threshold
    separates them — but only one of them is the surface under the car, and
    measuring the average wetness of two unrelated pieces of track is a number
    that describes nowhere.

    The component is chosen by area *and* by whether it reaches the bottom of
    the frame near the camera axis, because the biggest blob is not always the
    near one: on a long straight the far run-off can out-area the track.
    """
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if n <= 1:
        return mask

    h, w = mask.shape
    ego_col = int(ego_x * w)
    band = max(1, h // 12)

    best_label = 0
    best_score = -1.0
    for label in range(1, n):
        area = stats[label, cv2.CC_STAT_AREA]
        if area < (h * w) * 0.004:
            continue
        component = labels[h - band :, :] == label
        touches_ego = bool(component[:, max(0, ego_col - w // 8) : ego_col + w // 8].any())
        # Reaching the camera is worth more than being large.
        score = area * (3.0 if touches_ego else 1.0)
        if score > best_score:
            best_score = score
            best_label = label

    if best_label == 0:
        return mask
    return (labels == best_label).astype(np.uint8)


def _row_run(
    row: np.ndarray,
    seed: int,
    speckle_bridge: int,
    prev_width: int,
) -> tuple[int, int, int] | None:
    """The road on one row, bridging holes but not kerbs.

    Two different things separate runs on a row and they need opposite
    treatment. A hole — a car ahead, spray, a shadow, a puddle the model was
    unsure about — sits *inside* the road and must be bridged. A kerb sits at
    the boundary, and bridging it merges the racing surface with the run-off
    beyond, which is exactly what this module exists to prevent.

    A width budget cannot tell them apart, and tuning one is a losing game: a
    car directly ahead can occupy a fifth of the frame, which is wider than the
    kerb it must not jump. So the discriminator is not the size of the gap but
    what bridging it *does to the width of the row*. Filling a hole leaves the
    row about as wide as the row below it; crossing a kerb makes it markedly
    wider. `prev_width` is what makes that check possible, and it is the same
    geometric-continuity argument the browser tracer uses to keep out of the sky.
    """
    idx = np.flatnonzero(row)
    if idx.size == 0:
        return None

    breaks = np.flatnonzero(np.diff(idx) > 1)
    starts = np.concatenate(([0], breaks + 1))
    ends = np.concatenate((breaks, [idx.size - 1]))

    # Merge pixel-scale gaps unconditionally — those are quantisation, not
    # structure, and carrying them into the continuity test is just noise.
    runs: list[list[int]] = []
    for s, e in zip(starts, ends):
        a, b = int(idx[s]), int(idx[e])
        if runs and a - runs[-1][1] <= speckle_bridge:
            runs[-1][1] = b
        else:
            runs.append([a, b])

    # Start from the run continuous with the row below. Only fall back to the
    # widest when the seed lands in a hole.
    containing = [k for k, r in enumerate(runs) if r[0] <= seed <= r[1]]
    k = containing[0] if containing else max(range(len(runs)), key=lambda j: runs[j][1] - runs[j][0])
    lo, hi = runs[k]

    # Without a previous row there is nothing to be continuous with, so fall
    # back to accepting the run as found.
    cap = int(prev_width * 1.45) if prev_width > 0 else int(hi - lo + speckle_bridge * 4)

    # Absorb neighbours outward while the row stays width-consistent.
    left_k, right_k = k, k
    grew = True
    while grew:
        grew = False
        if left_k > 0:
            cand_lo = runs[left_k - 1][0]
            if hi - cand_lo <= cap:
                lo = cand_lo
                left_k -= 1
                grew = True
        if right_k < len(runs) - 1:
            cand_hi = runs[right_k + 1][1]
            if cand_hi - lo <= cap:
                hi = cand_hi
                right_k += 1
                grew = True

    return lo, hi, hi - lo


def _refine_with_lane_lines(
    left: int,
    right: int,
    lane_row: np.ndarray | None,
    cfg: CorridorConfig,
) -> tuple[int, int, bool]:
    """Pull the boundary in to a lane marking, where one exists.

    This is the race-track correction, and it is the reason a public-road model
    can be used at all. BDD100K teaches a network what asphalt looks like; it
    does not teach it that on a circuit the asphalt continues well past the
    white line into run-off that no car is racing on. The drivable mask
    therefore over-reports the racing surface, and measuring the run-off drags
    the edge bands toward whatever that surface is doing — which is the exact
    signal the dry-line call is built on.

    Where the lane head fires inside the mask, that marking is the track limit
    and it wins. Where it does not — worn paint, spray, night — the mask edge
    stands, and `limits_from` says which happened so the reading can be read
    with the right amount of trust.
    """
    if lane_row is None:
        return left, right, False

    span = right - left
    if span <= 0:
        return left, right, False

    # Only look in the outer third of each side. A marking in the middle is a
    # pit-lane line or a start-grid box, not a track limit.
    window = max(2, int(span * 0.34))
    left_zone = lane_row[left : left + window]
    right_zone = lane_row[max(left, right - window) : right + 1]

    new_left, new_right = left, right
    found = False

    left_hits = np.flatnonzero(left_zone)
    if left_hits.size:
        # Innermost marking on the left: the racing surface starts inside it.
        new_left = left + int(left_hits.max())
        found = True

    right_hits = np.flatnonzero(right_zone)
    if right_hits.size:
        new_right = max(left, right - window) + int(right_hits.min())
        found = True

    if new_right - new_left < span * 0.35:
        # The markings would leave a sliver. More likely two lines of the same
        # kerb than the two limits of the track.
        return left, right, False

    return new_left, new_right, found


def _fit_quadratic(values: np.ndarray, mask: np.ndarray) -> np.ndarray | None:
    """Least-squares quadratic through the measured rows.

    Same reasoning as the browser tracer: a road under a fixed camera is a
    smooth arc, and three coefficients express one while being far too stiff to
    chase a single bad row. Rows the scan missed are then filled from the fit.
    """
    n = values.size
    idx = np.flatnonzero(mask)
    if idx.size < 6:
        return None
    u = idx / n
    try:
        coeffs = np.polyfit(u, values[idx], 2)
    except (np.linalg.LinAlgError, ValueError):
        return None
    return np.polyval(coeffs, np.arange(n) / n)


def _seed_index(
    road: np.ndarray,
    sample_rows: np.ndarray,
    min_width_px: int,
    speckle_px: int,
) -> tuple[int, int] | None:
    """Find an unobstructed road row ahead of the camera/vehicle.

    Starting at the bottom is wrong for onboard footage: the nose splits the
    road mask into two wedges and the row scanner confidently follows one of
    them. Search the mid-depth view instead, where the whole track is visible,
    then grow both toward the horizon and toward the vehicle.
    """
    h, w = road.shape
    centre = w // 2
    best: tuple[float, int, int] | None = None

    for i, y in enumerate(sample_rows):
        ny = y / h
        if ny < 0.34 or ny > 0.70:
            continue
        run = _row_run(road[y], centre, speckle_px, 0)
        if run is None:
            continue
        left, right, width = run
        if width < min_width_px:
            continue

        run_centre = (left + right) // 2
        spans_centre = left <= centre <= right
        spans_both_sides = left / w <= 0.38 and right / w >= 0.62
        depth_score = 1.0 - min(1.0, abs(ny - 0.50) / 0.28)
        score = (
            width / w
            + (0.35 if spans_both_sides else 0.15 if spans_centre else -0.30)
            + depth_score * 0.15
            - abs(run_centre / w - 0.5) * 0.15
        )
        if best is None or score > best[0]:
            best = (score, i, run_centre)

    return (best[1], best[2]) if best else None


def _bottom_connected_centre_gap(
    road: np.ndarray,
    sample_rows: np.ndarray,
    index: int,
    centre: int,
) -> bool:
    """Whether a central obstruction continues from this row to frame bottom.

    A car ahead makes a bounded hole and road reappears below it, so it should
    be bridged. A camera hood/nose reaches the bottom and must terminate the
    measurable corridor before the sampler starts reading bodywork.
    """
    _, w = road.shape
    radius = max(1, int(w * 0.008))
    lo, hi = max(0, centre - radius), min(w, centre + radius + 1)
    row = road[sample_rows[index]]
    if row[lo:hi].any() or not row[:lo].any() or not row[hi:].any():
        return False
    return all(not road[y, lo:hi].any() for y in sample_rows[index:])


def corridor_from_masks(
    road_prob: np.ndarray,
    lane_prob: np.ndarray | None,
    cfg: CorridorConfig,
) -> Corridor | None:
    """Build a corridor from a road probability map and an optional lane map.

    Both are float arrays in [0, 1] at any resolution; the corridor is returned
    in normalised coordinates so the caller never has to think about scale.

    Returns None when the mask does not describe a usable road. That is a real
    answer and the caller must have somewhere to fall back to — a camera cutting
    to a studio shot should produce nothing here, not a corridor across a desk.
    """
    if road_prob.ndim != 2:
        raise ValueError(f"road_prob must be 2-D, got shape {road_prob.shape}")

    h, w = road_prob.shape
    road = (road_prob >= cfg.road_threshold).astype(np.uint8)
    if road.sum() < (h * w) * 0.01:
        return None

    # Close pixel-scale speckle before component analysis, or a dusting of
    # stray confidence fragments the road into a hundred tiny components and
    # the largest-component step picks one of the fragments.
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    road = cv2.morphologyEx(road, cv2.MORPH_CLOSE, kernel)
    road = cv2.morphologyEx(road, cv2.MORPH_OPEN, kernel)
    road = _largest_component_containing_ego(road)

    lane = None
    if lane_prob is not None:
        if lane_prob.shape != road_prob.shape:
            lane_prob = cv2.resize(lane_prob, (w, h), interpolation=cv2.INTER_LINEAR)
        lane = (lane_prob >= cfg.lane_threshold).astype(np.uint8)

    ys = np.flatnonzero(road.any(axis=1))
    if ys.size < 8:
        return None
    y_first, y_last = int(ys[0]), int(ys[-1])

    rows = cfg.rows
    sample_rows = np.linspace(y_first, y_last, rows).round().astype(int)

    left = np.zeros(rows, dtype=np.float64)
    right = np.zeros(rows, dtype=np.float64)
    found = np.zeros(rows, dtype=bool)
    limits_from_lane = 0

    min_width_px = max(2, int(cfg.min_row_width * w))
    speckle_px = max(2, int(cfg.max_bridge * w * 0.12))

    seed = _seed_index(road, sample_rows, min_width_px, speckle_px)
    if seed is None:
        return None
    seed_i, seed_x = seed

    def walk(start: int, stop: int, step: int) -> None:
        nonlocal limits_from_lane
        centre = seed_x
        prev_width = 0
        misses = 0
        i = start
        while (i <= stop if step > 0 else i >= stop):
            if step > 0 and _bottom_connected_centre_gap(road, sample_rows, i, centre):
                break

            run = _row_run(road[sample_rows[i]], centre, speckle_px, prev_width)
            if run is None or run[2] < min_width_px:
                misses += 1
                if misses > 3:
                    break
                i += step
                continue
            misses = 0

            a, b, _ = run
            lane_row = lane[sample_rows[i]] if lane is not None else None
            a, b, from_lane = _refine_with_lane_lines(a, b, lane_row, cfg)
            if from_lane:
                limits_from_lane += 1

            left[i] = a
            right[i] = b
            found[i] = True
            centre = (a + b) // 2
            prev_width = b - a
            i += step

    walk(seed_i, rows - 1, 1)
    walk(seed_i - 1, 0, -1)

    measured = int(found.sum())
    if measured < 8:
        return None

    fit_l = _fit_quadratic(left, found)
    fit_r = _fit_quadratic(right, found)
    if fit_l is None or fit_r is None:
        return None

    # Report only across rows that were measured. Evaluating the fit outside
    # them hands back a confident corridor over rows where no road was seen —
    # the same failure the browser tracer had, where it drew straight over the
    # car's own nose.
    first, last = int(np.argmax(found)), rows - 1 - int(np.argmax(found[::-1]))
    if last - first < 6:
        return None

    src = np.linspace(first, last, rows)
    out_l = np.interp(src, np.arange(rows), fit_l)
    out_r = np.interp(src, np.arange(rows), fit_r)

    lo = np.minimum(out_l, out_r)
    hi = np.maximum(out_l, out_r)
    # Emit raw track limits, exactly like LaneTrace. The browser applies the
    # single sampling inset in corridorFromTrace; doing it here too narrowed a
    # segmented corridor twice and made the overlay disagree with the mask.
    lo = np.clip(lo / w, 0.0, 1.0)
    hi = np.clip(hi / w, 0.0, 1.0)

    mean_width = float(np.mean(hi - lo))
    if mean_width < cfg.min_row_width:
        return None

    reported_span = last - first + 1
    confidence = float(measured / reported_span)

    return Corridor(
        y_top=float(sample_rows[first] / h),
        y_bot=float(sample_rows[last] / h),
        left=[round(float(v), 5) for v in lo],
        right=[round(float(v), 5) for v in hi],
        confidence=round(confidence, 4),
        measured_rows=measured,
        mean_width=round(mean_width, 5),
        limits_from="lane_markings" if limits_from_lane > measured * 0.4 else "mask_edge",
    )
