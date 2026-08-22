/**
 * Lane tracing.
 *
 * The detector needs to know which pixels are road before it can say anything
 * about the road. Until now that was a fixed perspective trapezoid, positioned
 * either by hand or by a grid search over ~84 candidate boxes scored on
 * saturation. Both produce the same shape: a straight-sided quadrilateral that
 * cannot follow a corner, cannot react to the camera panning, and on a curve
 * necessarily includes whatever is on the outside of it — grass, gravel, a
 * barrier — while missing tarmac on the inside.
 *
 * That matters more here than it would in a lane-keeping system, because this
 * pipeline does not just locate the road, it *measures* it. Grass inside the
 * region drags saturation up and texture down; a painted kerb is bright and
 * desaturated and reads as standing water. A box that is 90% correct produces a
 * confident wetness index that is wrong, which is worse than no index at all.
 *
 * So the road is traced rather than approximated:
 *
 *   1. Find a seed — a patch that actually looks like tarmac.
 *   2. Grow row by row from it, taking the contiguous run of pixels that match
 *      the surface, with the reference re-estimated at every row.
 *   3. Fit smooth curves through the boundaries so one occluded row or one kerb
 *      does not bend the corridor.
 *   4. Blend with the previous trace so it tracks rather than jitters.
 *
 * Step 2 is what makes it a trace: each row's search starts from the row below
 * it, so the corridor follows the road as it bends. Nothing about the shape is
 * assumed in advance.
 *
 * Costs about a millisecond at 384 px and does not run every frame — see
 * `LaneTracker` at the bottom.
 */

/**
 * Deliberately imports nothing from the rest of the project.
 *
 * This is a pure function of an ImageData, and keeping it that way means it can
 * be run and checked outside a browser — see `scripts/lane-test.mjs`, which
 * feeds it synthetic roads with known geometry. A tracer that can only be
 * exercised by loading footage into a tab is a tracer nobody checks.
 */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * A traced road corridor.
 *
 * Stored as two boundary arrays sampled at `ROWS` evenly spaced depths between
 * `yTop` and `yBot`, in normalised coordinates so it survives a resolution
 * change. Per-row rather than four corners: that is the whole point.
 */
export interface LaneTrace {
  yTop: number;
  yBot: number;
  /** Normalised x of the left boundary, far row first. */
  left: Float32Array;
  /** Normalised x of the right boundary, far row first. */
  right: Float32Array;
  /** Fraction of rows found by measurement rather than extrapolation, 0..1. */
  confidence: number;
  /** Rows the scan actually accepted. */
  measuredRows: number;
  /** Mean corridor width, normalised. Thin traces are usually a false lock. */
  meanWidth: number;
  /** Mean saturation of the traced surface — tarmac is grey, grass is not. */
  surfaceSat: number;
  /** Mean luma of the traced surface. */
  surfaceLuma: number;
  at: number;
}

/** Rows sampled across the corridor. Enough to follow a corner, cheap to fit. */
export const ROWS = 48;

export interface TraceOptions {
  /** Top of the search region, normalised. Above this is horizon and sky. */
  searchTop: number;
  /** Bottom of the search region. Below this, on an onboard camera, is the car. */
  searchBottom: number;
  /** Above this saturation a pixel is coloured — grass, livery, kerb — not tarmac. */
  maxSat: number;
  /** How far a pixel's luma may sit from the running surface reference. */
  lumaTolerance: number;
  /** Minimum corridor width to accept, normalised. Narrower is a false lock. */
  minWidth: number;
}

export const DEFAULT_TRACE_OPTIONS: TraceOptions = {
  // Road on onboard/cockpit feeds starts below the horizon (~0.32-0.36)
  // and ends ahead of the steering wheel and nosecone (~0.85).
  searchTop: 0.32,
  searchBottom: 0.85,
  // Asphalt is near-colourless. 0.30 admits weathered and wet tarmac (water
  // raises apparent saturation slightly) while still rejecting grass and
  // liveries, which sit far above it.
  maxSat: 0.3,
  lumaTolerance: 46,
  minWidth: 0.08,
};

// ── Scratch buffers ────────────────────────────────────────────────────
//
// Allocated once. This runs next to a pipeline whose whole design goal is that
// nothing allocates while a session is live, because a GC pause lands as a
// visible stall in the readout.

let lumaBuf: Float32Array | null = null;
let satBuf: Float32Array | null = null;
let skyBuf: Uint8Array | null = null;
let bufW = 0;
let bufH = 0;

const leftRaw = new Float32Array(ROWS);
const rightRaw = new Float32Array(ROWS);
const rowFound = new Uint8Array(ROWS);
const rowY = new Int32Array(ROWS);

function ensure(w: number, h: number) {
  if (bufW === w && bufH === h && lumaBuf && skyBuf) return;
  lumaBuf = new Float32Array(w * h);
  satBuf = new Float32Array(w * h);
  skyBuf = new Uint8Array(w * h);
  bufW = w;
  bufH = h;
}

/** Allocate ahead of the session, so the first traced frame costs the same as the thousandth. */
export function warmUpLane(w: number, h: number) {
  ensure(w, h);
  lumaBuf!.fill(0);
  satBuf!.fill(0);
  skyBuf!.fill(0);
}

/**
 * Luma and saturation over the search region only.
 *
 * Also isolates sky pixels (blue-dominant or overcast high-elevation gradients)
 * so the road corridor and measurements strictly stay on the tarmac.
 */
function prepare(img: ImageData, y0: number, y1: number) {
  const { width: w, height: h, data } = img;
  const luma = lumaBuf!;
  const sat = satBuf!;
  const sky = skyBuf!;
  sky.fill(0);

  for (let y = y0; y <= y1; y++) {
    const row = y * w;
    const ny = y / h;
    for (let x = 0; x < w; x += 2) {
      const i = (row + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
      const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
      const p = row + x;
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      const s = mx === 0 ? 0 : (mx - mn) / mx;
      luma[p] = l;
      sat[p] = s;

      // Sky detection: blue dominant or upper-frame pale sky
      const isSky =
        ny < 0.44 &&
        ((b > r + 8 && b > g) || (ny < 0.38 && l > 175 && s < 0.18));
      sky[p] = isSky ? 1 : 0;

      // Mirror into the odd column so the row scan can step by one without
      // branching on parity.
      if (x + 1 < w) {
        luma[p + 1] = l;
        sat[p + 1] = s;
        sky[p + 1] = isSky ? 1 : 0;
      }
    }
  }
}

interface Seed {
  y: number;
  x: number;
  luma: number;
  score: number;
}

/**
 * Find somewhere to start on the open track ahead of the car.
 *
 * On an onboard / cockpit camera:
 * - The car's nosecone, front wheels, and cockpit occupy the lower portion (y >= 0.58).
 * - The clear, unobstructed road is in the mid-depth window (y between searchTop and ~0.56).
 * - A true track spans across the full width of the view — extending BOTH to the left of the
 *   car and to the right of the car (left < 0.35, right > 0.65).
 * - An isolated patch between the tyre and nosecone only spans one side and is rejected.
 */
function findSeed(img: ImageData, opts: TraceOptions, priorCenterX = 0.5): Seed | null {
  const { width: w, height: h } = img;
  const luma = lumaBuf!;
  const sat = satBuf!;

  let best: Seed | null = null;

  // Search candidate depths in the open road zone ahead of the car hood
  // Never seed on the car. A T-cam/halo view commonly puts grey or black
  // bodywork below ~0.58; it can look more like asphalt than the asphalt does.
  const yStart = Math.floor(Math.min(0.56, opts.searchBottom) * h);
  const yEnd = Math.ceil(opts.searchTop * h);

  const paintGap = Math.max(4, Math.round(w * 0.04));

  for (let y = yStart; y >= yEnd; y -= 2) {
    if (y < 1 || y >= h - 1) continue;
    const row = y * w;
    const ny = y / h;

    // Test positions centered on the forward track view
    const candidateXs = [
      priorCenterX,
      0.5,
      priorCenterX - 0.08,
      priorCenterX + 0.08,
      0.44,
      0.56,
      priorCenterX - 0.16,
      priorCenterX + 0.16,
    ].filter((x, idx, arr) => x >= 0.20 && x <= 0.80 && arr.indexOf(x) === idx);

    for (const cx of candidateXs) {
      const x0 = Math.max(1, Math.floor((cx - 0.04) * w));
      const x1 = Math.min(w - 2, Math.ceil((cx + 0.04) * w));
      if (x1 - x0 < 3) continue;

      let sumL = 0;
      let sumS = 0;
      let n = 0;
      for (let x = x0; x <= x1; x++) {
        sumL += luma[row + x];
        sumS += sat[row + x];
        n++;
      }
      if (n === 0) continue;
      const meanL = sumL / n;
      const meanS = sumS / n;

      if (meanL < 18 || meanL > 248) continue;
      if (meanS > opts.maxSat) continue;

      let varL = 0;
      for (let x = x0; x <= x1; x++) {
        const d = luma[row + x] - meanL;
        varL += d * d;
      }
      varL /= n;

      // Span test: walk left and right with paint-gap tolerance across white lines
      const px = Math.round((x0 + x1) / 2);
      let leftSpan = px;
      let rightSpan = px;
      let pMiss = 0;

      for (let x = px - 1; x >= 1; x--) {
        const s = sat[row + x];
        const l = luma[row + x];
        if (s > opts.maxSat) break;
        if (Math.abs(l - meanL) <= opts.lumaTolerance * 1.4) {
          leftSpan = x;
          pMiss = 0;
        } else {
          if (++pMiss > paintGap) break;
        }
      }

      pMiss = 0;
      for (let x = px + 1; x < w - 1; x++) {
        const s = sat[row + x];
        const l = luma[row + x];
        if (s > opts.maxSat) break;
        if (Math.abs(l - meanL) <= opts.lumaTolerance * 1.4) {
          rightSpan = x;
          pMiss = 0;
        } else {
          if (++pMiss > paintGap) break;
        }
      }

      const lNorm = leftSpan / w;
      const rNorm = rightSpan / w;
      const spanNorm = rNorm - lNorm;

      if (spanNorm < opts.minWidth) continue;

      const spansCenter = lNorm <= 0.48 && rNorm >= 0.52;
      const spansBothSides = lNorm <= 0.38 && rNorm >= 0.62;

      // A wheel-side gap or a strip of grey verge can score well on colour,
      // width and depth. It is still not the road in front of the camera.
      // This is a validity condition, not a preference in the score.
      if (!spansCenter) continue;

      const greyness = 1 - meanS / opts.maxSat;
      const flatness = 1 / (1 + varL / 260);

      // Prefer road depth in open area ahead of the nose (y ~ 0.48 - 0.54)
      const depthScore = 1 - Math.min(1, Math.abs(ny - 0.50) / 0.28);
      const spanScore = Math.min(1, spanNorm / 0.50);
      const centerDist = Math.abs(cx - priorCenterX);
      const centerScore = 1 - Math.min(1, centerDist / 0.35);
      const fullRoadBonus = spansBothSides ? 0.35 : 0.15;

      const score =
        greyness * 0.25 +
        flatness * 0.15 +
        spanScore * 0.30 +
        depthScore * 0.15 +
        centerScore * 0.15 +
        fullRoadBonus;

      if (!best || score > best.score) {
        best = { y, x: px, luma: meanL, score };
      }
    }
  }

  return best && best.score > 0.36 ? best : null;
}

/**
 * Walk left and right from a centre point while the surface holds.
 */
function scanRow(
  y: number,
  seedX: number,
  seedReference: number,
  w: number,
  opts: TraceOptions,
  prevWidth: number,
  direction: number,
): { l: number; r: number; sumL: number; sumS: number; n: number; variance: number } | null {
  let cx = seedX;
  let reference = seedReference;
  const luma = lumaBuf!;
  const sat = satBuf!;
  const row = y * w;
  const tol = opts.lumaTolerance;

  const paintGap = Math.max(4, Math.round(w * 0.04));
  const materialGap = 3;
  const minLimitDistance = w * 0.025;

  const isBrightNeutral = (x: number, yy: number, brightLimit: number) => {
    if (x < 1 || x > w - 2 || yy < 1 || yy >= bufH - 1) return false;
    const p = yy * w + x;
    return sat[p] <= Math.min(0.16, opts.maxSat) && luma[p] >= brightLimit;
  };

  const isTrackLimit = (x: number) => {
    if (Math.abs(x - cx) < minLimitDistance) return false;
    const brightLimit = Math.max(158, reference + tol * 0.72);
    if (!isBrightNeutral(x, y, brightLimit)) return false;

    // Water/glare is a region, not a stripe. Only a narrow bright run can be a
    // painted limit; broad highlights must remain measurable road surface.
    let lo = x;
    let hi = x;
    const maxStripe = Math.max(5, Math.round(w * 0.035));
    while (lo > 1 && isBrightNeutral(lo - 1, y, brightLimit) && x - lo <= maxStripe) lo--;
    while (hi < w - 2 && isBrightNeutral(hi + 1, y, brightLimit) && hi - x <= maxStripe) hi++;
    if (hi - lo + 1 > maxStripe) return false;

    // Track limits run along the course. Grid marks, isolated reflections and
    // compression flashes do not persist vertically around the same x.
    let persists = 0;
    for (const dy of [-4, -2, 2, 4]) {
      let seen = false;
      for (let dx = -5; dx <= 5 && !seen; dx++) {
        seen = isBrightNeutral(x + dx, y + dy, brightLimit);
      }
      if (seen) persists++;
    }
    return persists >= 3;
  };

  let sumL = 0;
  let sumL2 = 0;
  let sumS = 0;
  let n = 0;

  /** 2 = surface, 1 = break that is still road-coloured (paint/wet/shadow), 0 = another material or sky. */
  const test = (x: number): 0 | 1 | 2 => {
    if (x < 1 || x > w - 2) return 0;
    const p = row + x;
    if (skyBuf && skyBuf[p] === 1) return 0;
    if (sat[p] > opts.maxSat) return 0;
    return Math.abs(luma[p] - reference) <= tol ? 2 : 1;
  };

  if (cx < 1 || cx > w - 2) return null;

  if (test(cx) !== 2) {
    let recovered = -1;
    for (let d = 1; d <= paintGap; d++) {
      if (cx - d >= 1 && test(cx - d) === 2) { recovered = cx - d; break; }
      if (cx + d <= w - 2 && test(cx + d) === 2) { recovered = cx + d; break; }
    }

    if (recovered >= 0) {
      cx = recovered;
    } else {
      let lo = cx;
      let hi = cx;
      while (lo > 1 && sat[row + lo - 1] <= opts.maxSat) lo--;
      while (hi < w - 2 && sat[row + hi + 1] <= opts.maxSat) hi++;

      if (hi - lo < Math.max(6, w * 0.05)) return null;

      const cap = prevWidth > 0 ? (direction < 0 ? prevWidth * 1.04 : prevWidth * 1.65) : w * 0.55;
      if (hi - lo > cap) return null;

      let sum = 0;
      let count = 0;
      for (let x = lo; x <= hi; x++) {
        sum += luma[row + x];
        count++;
      }
      reference = sum / count;
      cx = Math.round((lo + hi) / 2);
      if (test(cx) !== 2) return null;
    }
  }

  const walk = (from: number, step: number, limit: number) => {
    let edge = cx;
    let paint = 0;
    let material = 0;
    let boundary = false;
    for (let x = from; step > 0 ? x <= limit : x >= limit; x += step) {
      const t = test(x);
      if (t === 2) {
        edge = x;
        paint = 0;
        material = 0;
        const v = luma[row + x];
        sumL += v;
        sumL2 += v * v;
        sumS += sat[row + x];
        n++;
      } else if (t === 1) {
        // A solid white track-limit line is not a gap to bridge. This is what
        // separates racing surface from same-colour asphalt runoff, especially
        // on skidpads and paved Formula Student courses. Ignore markings close
        // to the centre (grid/centre lines), but stop at a bright neutral stripe
        // far enough out to be a plausible boundary.
        if (isTrackLimit(x)) {
          boundary = true;
          break;
        }
        if (++paint > paintGap) {
          boundary = true;
          break;
        }
      } else if (++material > materialGap) {
          boundary = true;
          break;
      }
    }
    return { edge, boundary };
  };

  const leftWalk = walk(cx, -1, 1);
  const rightWalk = walk(cx + 1, 1, w - 2);
  const l = leftWalk.edge;
  const r = rightWalk.edge;

  // A grey field reaching both frame edges contains no evidence of where the
  // course ends. Returning it as a high-confidence road is how the overlay
  // wandered across paved runoff. One visible material or painted limit is the
  // minimum evidence; the temporal tracker can carry the other side briefly.
  if (!leftWalk.boundary && !rightWalk.boundary) return null;

  // Perspective is strictly monotonic: road narrows toward horizon (-1), widens toward camera (+1)
  if (prevWidth > 0 && r - l > prevWidth * (direction < 0 ? 1.04 : 1.85)) {
    return null;
  }

  if (r - l < 3 || n < 3) return null;
  const mean = sumL / n;
  return { l, r, sumL, sumS, n, variance: Math.max(0, sumL2 / n - mean * mean) };
}

/**
 * Least-squares quadratic through the measured boundary points.
 */
function fitQuadratic(xs: Float32Array, mask: Uint8Array, n: number): [number, number, number] | null {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  let t0 = 0, t1 = 0, t2 = 0;

  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const u = i / n;
    const u2 = u * u;
    s0 += 1;
    s1 += u;
    s2 += u2;
    s3 += u2 * u;
    s4 += u2 * u2;
    t0 += xs[i];
    t1 += xs[i] * u;
    t2 += xs[i] * u2;
  }
  if (s0 < 5) return null;

  const det =
    s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
  if (Math.abs(det) < 1e-9) return null;

  const a =
    (t0 * (s2 * s4 - s3 * s3) - s1 * (t1 * s4 - t2 * s3) + s2 * (t1 * s3 - t2 * s2)) / det;
  const b =
    (s0 * (t1 * s4 - t2 * s3) - t0 * (s1 * s4 - s3 * s2) + s2 * (s1 * t2 - s2 * t1)) / det;
  const c =
    (s0 * (s2 * t2 - s3 * t1) - s1 * (s1 * t2 - s2 * t1) + t0 * (s1 * s3 - s2 * s2)) / det;

  return [a, b, c];
}

/**
 * Trace the road in one frame.
 */
export function traceLane(
  img: ImageData,
  opts: TraceOptions = DEFAULT_TRACE_OPTIONS,
  priorCenterX = 0.5,
): LaneTrace | null {
  const { width: w, height: h } = img;
  if (w < 32 || h < 32) return null;

  ensure(w, h);
  const y0 = Math.max(1, Math.floor(opts.searchTop * h));
  const y1 = Math.min(h - 2, Math.floor(opts.searchBottom * h));
  if (y1 - y0 < 8) return null;

  prepare(img, y0, y1);

  const seed = findSeed(img, opts, priorCenterX);
  if (!seed) return null;

  rowFound.fill(0);
  let measured = 0;
  let surfSumL = 0;
  let surfSumS = 0;
  let surfN = 0;

  for (let i = 0; i < ROWS; i++) {
    rowY[i] = Math.round(y0 + ((y1 - y0) * i) / (ROWS - 1));
  }

  const seedIdx = clamp(Math.round(((seed.y - y0) / Math.max(1, y1 - y0)) * (ROWS - 1)), 0, ROWS - 1);

  const walk = (from: number, to: number, step: number) => {
    let cx = seed.x;
    let reference = seed.luma;
    let misses = 0;
    let prevWidth = 0;

    for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
      const cy = rowY[i];

      // On downward scan (approaching vehicle): stop when central road hits car hood / nosecone
      if (step > 0 && cy > 0.52 * h) {
        // The car is fixed in camera coordinates; the road centre is not. On a
        // turn `cx` can move far enough sideways that checking around it misses
        // the nose and lets the fitted boundary run straight across bodywork.
        const bodyCx = Math.round(w * 0.5);
        const centerOffset = Math.round(w * 0.06);
        const c1 = Math.max(1, bodyCx - centerOffset);
        const c2 = Math.min(w - 2, bodyCx + centerOffset);
        let centerSat = 0;
        let roadLike = 0;
        let sideRoadLike = 0;
        let sideCount = 0;
        let cnt = 0;
        for (let x = c1; x <= c2; x++) {
          const p = cy * w + x;
          centerSat += satBuf![p];
          if (
            satBuf![p] <= opts.maxSat &&
            Math.abs(lumaBuf![p] - reference) <= opts.lumaTolerance
          ) roadLike++;
          cnt++;
        }
        const inner = Math.round(w * 0.10);
        const outer = Math.round(w * 0.19);
        for (let dx = -outer; dx <= outer; dx++) {
          if (Math.abs(dx) < inner) continue;
          const x = bodyCx + dx;
          if (x < 1 || x > w - 2) continue;
          const p = cy * w + x;
          if (
            satBuf![p] <= opts.maxSat &&
            Math.abs(lumaBuf![p] - reference) <= opts.lumaTolerance
          ) sideRoadLike++;
          sideCount++;
        }
        const centerShare = roadLike / Math.max(1, cnt);
        const sideShare = sideRoadLike / Math.max(1, sideCount);
        // Coloured, black and bare-carbon noses are all common. Saturation alone
        // only catches liveries. A neutral nose is a *local* centre obstruction;
        // a brightness change spanning the side patches too is water/shadow and
        // must be allowed to update the running road reference.
        if (
          cnt > 0 &&
          (
            centerSat / cnt > opts.maxSat * 1.1 ||
            (centerShare < 0.42 && sideShare > centerShare + 0.24)
          )
        ) {
          break;
        }
      }

      // On upward scan (approaching horizon/sky): stop when row enters sky
      if (step < 0 && cy < 0.48 * h && skyBuf) {
        let skyCount = 0;
        const testRadius = Math.max(4, Math.round(w * 0.08));
        for (let dx = -testRadius; dx <= testRadius; dx++) {
          const tx = clamp(cx + dx, 1, w - 2);
          if (skyBuf[cy * w + tx] === 1) skyCount++;
        }
        if (skyCount / (testRadius * 2 + 1) > 0.35) {
          break;
        }
      }

      const hit = scanRow(cy, cx, reference, w, opts, prevWidth, step);

      if (!hit) {
        if (++misses > 3) break;
        continue;
      }
      misses = 0;

      leftRaw[i] = hit.l / w;
      rightRaw[i] = hit.r / w;
      rowFound[i] = 1;
      measured++;

      surfSumL += hit.sumL;
      surfSumS += hit.sumS;
      surfN += hit.n;

      cx = Math.round((hit.l + hit.r) / 2);
      prevWidth = hit.r - hit.l;
      reference = reference * 0.6 + (hit.sumL / hit.n) * 0.4;
    }
  };

  walk(seedIdx, ROWS - 1, 1); // toward the camera / vehicle
  walk(seedIdx - 1, 0, -1); // toward the horizon

  if (measured < 8) return null;

  let first = -1;
  let last = -1;
  for (let i = 0; i < ROWS; i++) {
    if (!rowFound[i]) continue;
    if (first < 0) first = i;
    last = i;
  }
  if (first < 0 || last - first < 6) return null;

  const fitL = fitQuadratic(leftRaw, rowFound, ROWS);
  const fitR = fitQuadratic(rightRaw, rowFound, ROWS);
  if (!fitL || !fitR) return null;

  const left = new Float32Array(ROWS);
  const right = new Float32Array(ROWS);
  let widthSum = 0;

  for (let i = 0; i < ROWS; i++) {
    const src = first + ((last - first) * i) / (ROWS - 1);
    const u = src / ROWS;
    let l = fitL[0] + fitL[1] * u + fitL[2] * u * u;
    let r = fitR[0] + fitR[1] * u + fitR[2] * u * u;
    if (r < l) [l, r] = [r, l];
    left[i] = clamp(l, 0, 1);
    right[i] = clamp(r, 0, 1);
    widthSum += right[i] - left[i];
  }

  const meanWidth = widthSum / ROWS;
  if (meanWidth < opts.minWidth) return null;

  const span = last - first + 1;

  return {
    yTop: Math.max(opts.searchTop, rowY[first] / h),
    yBot: rowY[last] / h,
    left,
    right,
    confidence: measured / span,
    measuredRows: measured,
    meanWidth,
    surfaceSat: surfN ? surfSumS / surfN : 1,
    surfaceLuma: surfN ? surfSumL / surfN : 0,
    at: performance.now(),
  };
}

// ── Tracking over time ─────────────────────────────────────────────────

/**
 * How often the trace is recomputed.
 * 60 ms keeps real-time responsiveness for headcam movement while smoothing jitter.
 */
const RETRACE_MS = 60;

/** Base correction is quiet on a straight; real motion raises it immediately. */
const TRACK_ALPHA_MIN = 0.30;
const TRACK_ALPHA_MAX = 0.82;

/** Below this the trace is not trusted enough to measure through. */
const MIN_CONFIDENCE = 0.50;

export type LaneState = 'searching' | 'locked' | 'lost';

export interface LaneStatus {
  state: LaneState;
  trace: LaneTrace | null;
  /** Consecutive traces that failed since the last lock. */
  misses: number;
  /** Wall-clock cost of the last trace attempt, milliseconds. */
  lastCostMs: number;
}

/**
 * Keeps a lane trace alive and rock-solid across frames.
 */
export class LaneTracker {
  private current: LaneTrace | null = null;
  private lastAttempt = 0;
  private misses = 0;
  private cost = 0;

  options: TraceOptions = { ...DEFAULT_TRACE_OPTIONS };

  /** Set false to hold the current corridor — used while the ROI is edited by hand. */
  enabled = true;

  get status(): LaneStatus {
    return {
      state: this.current ? 'locked' : this.misses > 0 ? 'lost' : 'searching',
      trace: this.current,
      misses: this.misses,
      lastCostMs: this.cost,
    };
  }

  get trace(): LaneTrace | null {
    return this.current;
  }

  reset() {
    this.current = null;
    this.lastAttempt = 0;
    this.misses = 0;
  }

  /** Force the next `update` to re-trace regardless of the interval. */
  invalidate() {
    this.lastAttempt = 0;
  }

  /**
   * Offer a frame. Returns the corridor to measure through.
   */
  update(img: ImageData, now = performance.now()): LaneTrace | null {
    if (!this.enabled) return this.current;
    if (now - this.lastAttempt < RETRACE_MS) return this.current;
    this.lastAttempt = now;

    const t0 = performance.now();
    // Use current corridor center as prior
    const priorCenter = this.current
      ? (this.current.left[Math.floor(ROWS / 2)] + this.current.right[Math.floor(ROWS / 2)]) / 2
      : 0.5;

    const fresh = traceLane(img, this.options, priorCenter);
    this.cost = performance.now() - t0;

    if (!fresh || fresh.confidence < MIN_CONFIDENCE) {
      this.misses++;
      if (this.misses > 16) this.current = null;
      return this.current;
    }

    // Outlier rejection: if fresh candidate suddenly leaps across the frame (e.g. wheel / spray lock),
    // don't immediately jump to it unless confirmed across consecutive frames.
    if (this.current) {
      const curCenter =
        (this.current.left[Math.floor(ROWS / 2)] + this.current.right[Math.floor(ROWS / 2)]) / 2;
      const freshCenter =
        (fresh.left[Math.floor(ROWS / 2)] + fresh.right[Math.floor(ROWS / 2)]) / 2;
      const centerDelta = Math.abs(freshCenter - curCenter);
      const widthRatio = fresh.meanWidth / Math.max(1e-4, this.current.meanWidth);

      // Sudden jump > 22% of screen width or extreme width change is treated as candidate outlier
      if (centerDelta > 0.22 || widthRatio < 0.45 || widthRatio > 2.2) {
        this.misses++;
        if (this.misses < 4) {
          return this.current;
        }
      }
    }

    this.misses = 0;
    if (!this.current) {
      this.current = fresh;
    } else {
      const i = Math.floor(ROWS / 2);
      const oldCenter = (this.current.left[i] + this.current.right[i]) / 2;
      const newCenter = (fresh.left[i] + fresh.right[i]) / 2;
      const centerMotion = Math.abs(newCenter - oldCenter);
      const widthMotion = Math.abs(fresh.meanWidth / Math.max(1e-4, this.current.meanWidth) - 1);
      // Fixed low-alpha smoothing visibly trails a corner. Scale the correction
      // with measured motion: stable straights stay smooth, steering responds
      // in the same frame instead of several retraces later.
      const alpha = clamp(
        TRACK_ALPHA_MIN + centerMotion * 4.0 + widthMotion * 0.35,
        TRACK_ALPHA_MIN,
        TRACK_ALPHA_MAX,
      );
      this.current = blend(this.current, fresh, alpha);
    }
    return this.current;
  }
}

/** Exponential blend of two traces, row by row. */
function blend(prev: LaneTrace, next: LaneTrace, a: number): LaneTrace {
  const left = new Float32Array(ROWS);
  const right = new Float32Array(ROWS);
  let widthSum = 0;

  // The two traces can cover different depth spans, so they are compared at the
  // same normalised depth rather than the same row index — otherwise a trace
  // that reached further up the road would drag the near rows with it.
  const yTop = prev.yTop + (next.yTop - prev.yTop) * a;
  const yBot = prev.yBot + (next.yBot - prev.yBot) * a;

  for (let i = 0; i < ROWS; i++) {
    const y = yTop + ((yBot - yTop) * i) / (ROWS - 1);
    const p = sampleAt(prev, y);
    const n = sampleAt(next, y);
    left[i] = p[0] + (n[0] - p[0]) * a;
    right[i] = p[1] + (n[1] - p[1]) * a;
    widthSum += right[i] - left[i];
  }

  return {
    yTop,
    yBot,
    left,
    right,
    confidence: prev.confidence + (next.confidence - prev.confidence) * a,
    measuredRows: next.measuredRows,
    meanWidth: widthSum / ROWS,
    surfaceSat: prev.surfaceSat + (next.surfaceSat - prev.surfaceSat) * a,
    surfaceLuma: prev.surfaceLuma + (next.surfaceLuma - prev.surfaceLuma) * a,
    at: next.at,
  };
}

/**
 * The corridor's left and right boundary at a normalised depth.
 *
 * Clamped rather than extrapolated outside the traced span: past the ends there
 * is no evidence, and continuing the curve there is how a trace ends up
 * describing the sky.
 */
export function sampleAt(trace: LaneTrace, y: number): [number, number] {
  const span = Math.max(1e-6, trace.yBot - trace.yTop);
  const f = clamp((y - trace.yTop) / span, 0, 1) * (ROWS - 1);
  const i = Math.floor(f);
  const j = Math.min(ROWS - 1, i + 1);
  const t = f - i;
  return [
    trace.left[i] + (trace.left[j] - trace.left[i]) * t,
    trace.right[i] + (trace.right[j] - trace.right[i]) * t,
  ];
}
