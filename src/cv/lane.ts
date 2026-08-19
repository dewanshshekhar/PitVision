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
  searchTop: 0.34,
  searchBottom: 0.98,
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
let bufW = 0;
let bufH = 0;

const leftRaw = new Float32Array(ROWS);
const rightRaw = new Float32Array(ROWS);
const rowFound = new Uint8Array(ROWS);
const rowY = new Int32Array(ROWS);

function ensure(w: number, h: number) {
  if (bufW === w && bufH === h && lumaBuf) return;
  lumaBuf = new Float32Array(w * h);
  satBuf = new Float32Array(w * h);
  bufW = w;
  bufH = h;
}

/** Allocate ahead of the session, so the first traced frame costs the same as the thousandth. */
export function warmUpLane(w: number, h: number) {
  ensure(w, h);
  lumaBuf!.fill(0);
  satBuf!.fill(0);
}

/**
 * Luma and saturation over the search region only.
 *
 * Every second pixel horizontally: the boundary is being located to within a
 * pixel or two of a 384-wide image, and the corridor is hundreds of pixels
 * across. Full resolution here buys nothing and doubles the cost.
 */
function prepare(img: ImageData, y0: number, y1: number) {
  const { width: w, data } = img;
  const luma = lumaBuf!;
  const sat = satBuf!;
  for (let y = y0; y <= y1; y++) {
    const row = y * w;
    for (let x = 0; x < w; x += 2) {
      const i = (row + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
      const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
      const p = row + x;
      luma[p] = 0.299 * r + 0.587 * g + 0.114 * b;
      sat[p] = mx === 0 ? 0 : (mx - mn) / mx;
      // Mirror into the odd column so the row scan can step by one without
      // branching on parity.
      if (x + 1 < w) {
        luma[p + 1] = luma[p];
        sat[p + 1] = sat[p];
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
 * Find somewhere to start.
 *
 * The trace has to begin on tarmac, and where tarmac is depends entirely on the
 * camera: a trackside shot has road across the lower half, an onboard camera
 * has the car's nose there and road above it, a cockpit view has mirrors and
 * bodywork down both sides. Assuming any of those is how the old fixed
 * trapezoid ended up measuring a Ferrari instead of a race track.
 *
 * So candidate patches are scored on what tarmac actually is — grey, mid-bright,
 * and *uniform across its width*, which is the test that separates a road from
 * a car (painted panels are uniform too, but coloured) and from grass (green,
 * and much noisier row to row).
 */
function findSeed(img: ImageData, opts: TraceOptions): Seed | null {
  const { width: w, height: h } = img;
  const luma = lumaBuf!;
  const sat = satBuf!;

  let best: Seed | null = null;

  // Search upward from the bottom of the region: the nearest road is the most
  // reliable place to lock on, being the largest and least foreshortened.
  const yStart = Math.floor(opts.searchBottom * h) - 2;
  const yEnd = Math.floor(opts.searchTop * h);

  for (let y = yStart; y > yEnd; y -= 3) {
    if (y < 1 || y >= h - 1) continue;
    const row = y * w;

    // Try a few horizontal positions — the road is not always centred, and on a
    // corner entry it can be well off to one side.
    for (const cx of [0.5, 0.38, 0.62, 0.28, 0.72]) {
      const x0 = Math.max(1, Math.floor((cx - 0.06) * w));
      const x1 = Math.min(w - 2, Math.ceil((cx + 0.06) * w));
      if (x1 - x0 < 4) continue;

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

      // Blown-out or black patches carry no surface information either way.
      if (meanL < 22 || meanL > 232) continue;
      if (meanS > opts.maxSat) continue;

      let varL = 0;
      for (let x = x0; x <= x1; x++) {
        const d = luma[row + x] - meanL;
        varL += d * d;
      }
      varL /= n;

      // Prefer grey over merely dark, uniform over speckled, and lower in the
      // frame over higher — nearer road is bigger and better resolved.
      const greyness = 1 - meanS / opts.maxSat;
      const flatness = 1 / (1 + varL / 260);
      const nearness = (y - yEnd) / Math.max(1, yStart - yEnd);
      const score = greyness * 0.5 + flatness * 0.3 + nearness * 0.2;

      if (!best || score > best.score) best = { y, x: Math.round((x0 + x1) / 2), luma: meanL, score };
    }
  }

  // A weak best is no lock at all. Reporting "no road found" is the honest
  // outcome and the app can say so, rather than tracing a corridor across the
  // sky and reporting a wetness index for it.
  return best && best.score > 0.42 ? best : null;
}

/**
 * Walk left and right from a centre point while the surface holds.
 *
 * `reference` is the luma the surface is expected to sit near, re-estimated per
 * row by the caller.
 *
 * A run has to survive breaks, because the road is not a uniform grey strip: it
 * carries white lines, tyre marks, shadows and puddle edges, and stopping at
 * the first one clips the corridor to a fraction of the tarmac. But it must not
 * survive *every* break, or it walks straight off the track and onto the grass.
 *
 * The two are told apart by which test the pixel fails, which is a physical
 * distinction rather than a tuned one:
 *
 * - Fails on luma but is still near-colourless → paint, shadow or a wet patch.
 *   Still road. Tolerated across a wide gap.
 * - Fails on saturation → a different material entirely: grass, kerbing,
 *   bodywork, gravel. Tolerated across almost nothing.
 *
 * Using one gap budget for both is what let a five-pixel white line split the
 * corridor while an eleven-pixel kerb was the thing the budget had been sized
 * against.
 */
function scanRow(
  y: number,
  seedX: number,
  reference: number,
  w: number,
  opts: TraceOptions,
): { l: number; r: number; sumL: number; sumS: number; n: number } | null {
  let cx = seedX;
  const luma = lumaBuf!;
  const sat = satBuf!;
  const row = y * w;
  const tol = opts.lumaTolerance;

  // Scaled to the frame so the behaviour does not change with sample width.
  // ~3% of width spans a track marking; a kerb or a verge is far wider.
  const paintGap = Math.max(4, Math.round(w * 0.03));
  const materialGap = 2;

  let sumL = 0;
  let sumS = 0;
  let n = 0;

  /** 2 = surface, 1 = a break that is still road-coloured, 0 = another material. */
  const test = (x: number): 0 | 1 | 2 => {
    if (sat[row + x] > opts.maxSat) return 0;
    return Math.abs(luma[row + x] - reference) <= tol ? 2 : 1;
  };

  if (cx < 1 || cx > w - 2) return null;

  // The starting point can land on something that is not the surface — most
  // often a painted line, since those run down the middle of a road and the
  // scan is handed the middle of the road. Giving up there loses the row, and
  // losing every row loses the trace. Step aside and look for the surface
  // within a marking's width before concluding there is none.
  if (test(cx) !== 2) {
    let recovered = -1;
    for (let d = 1; d <= paintGap; d++) {
      if (cx - d >= 1 && test(cx - d) === 2) { recovered = cx - d; break; }
      if (cx + d <= w - 2 && test(cx + d) === 2) { recovered = cx + d; break; }
    }
    if (recovered < 0) return null;
    cx = recovered;
  }

  const walk = (from: number, step: number, limit: number) => {
    let edge = cx;
    let paint = 0;
    let material = 0;
    for (let x = from; step > 0 ? x <= limit : x >= limit; x += step) {
      const t = test(x);
      if (t === 2) {
        edge = x;
        paint = 0;
        material = 0;
        sumL += luma[row + x];
        sumS += sat[row + x];
        n++;
      } else if (t === 1) {
        if (++paint > paintGap) break;
      } else if (++material > materialGap) {
        break;
      }
    }
    return edge;
  };

  const l = walk(cx, -1, 1);
  const r = walk(cx + 1, 1, w - 2);

  if (r - l < 3) return null;
  return { l, r, sumL, sumS, n };
}

/**
 * Least-squares quadratic through the measured boundary points.
 *
 * Quadratic, not a free curve: a road under a fixed camera is a smooth arc, and
 * three coefficients are enough to express one while being far too stiff to
 * chase a kerb or a car that clipped one row. Rows the scan missed are then
 * filled from the fit, which is what lets the corridor stay whole when
 * something crosses it.
 */
function fitQuadratic(xs: Float32Array, mask: Uint8Array, n: number): [number, number, number] | null {
  // Fitted against row *index*, not pixel y. The rows are sampled evenly, so
  // the two are related by a constant and the fit is identical — while the
  // index is already normalised, which keeps the normal equations conditioned
  // without a separate rescaling step.
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  let t0 = 0, t1 = 0, t2 = 0;

  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    // Normalised row index keeps the normal equations well conditioned.
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
  if (s0 < 6) return null;

  // Solve the 3x3 normal equations by Cramer's rule.
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
 *
 * Returns null when nothing road-like was found, which is a real answer: a
 * camera pointed at the pit garage should produce "no road", not a corridor.
 */
export function traceLane(img: ImageData, opts: TraceOptions = DEFAULT_TRACE_OPTIONS): LaneTrace | null {
  const { width: w, height: h } = img;
  if (w < 32 || h < 32) return null;

  ensure(w, h);
  const y0 = Math.max(1, Math.floor(opts.searchTop * h));
  const y1 = Math.min(h - 2, Math.floor(opts.searchBottom * h));
  if (y1 - y0 < 8) return null;

  prepare(img, y0, y1);

  const seed = findSeed(img, opts);
  if (!seed) return null;

  rowFound.fill(0);
  let measured = 0;
  let surfSumL = 0;
  let surfSumS = 0;
  let surfN = 0;

  // Rows are indexed far (0) to near (ROWS-1). The scan runs the other way,
  // from the seed outward in both directions, because each row's search has to
  // start from a row that has already been located.
  for (let i = 0; i < ROWS; i++) {
    rowY[i] = Math.round(y0 + ((y1 - y0) * i) / (ROWS - 1));
  }

  const seedIdx = clamp(Math.round(((seed.y - y0) / Math.max(1, y1 - y0)) * (ROWS - 1)), 0, ROWS - 1);

  const walk = (from: number, to: number, step: number) => {
    let cx = seed.x;
    let reference = seed.luma;
    let misses = 0;

    for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
      const hit = scanRow(rowY[i], cx, reference, w, opts);
      if (!hit) {
        // Several consecutive failures mean the surface has genuinely ended —
        // the horizon above, the car's bodywork below. Keep going a little in
        // case it was one shadow or one car crossing the frame.
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

      // Carry the centre and the surface reference into the next row. This is
      // what makes it follow a corner: the search for each row starts where the
      // road was one row closer, not where a fixed shape says it should be.
      cx = Math.round((hit.l + hit.r) / 2);
      reference = reference * 0.6 + (hit.sumL / hit.n) * 0.4;
    }
  };

  walk(seedIdx, ROWS - 1, 1); // toward the camera
  walk(seedIdx - 1, 0, -1); // toward the horizon

  if (measured < 10) return null;

  const fitL = fitQuadratic(leftRaw, rowFound, ROWS);
  const fitR = fitQuadratic(rightRaw, rowFound, ROWS);
  if (!fitL || !fitR) return null;

  // The corridor is reported only across the rows the scan actually reached.
  //
  // The fit is defined over the whole search region, and evaluating it there
  // would hand back a confident corridor covering rows where no road was ever
  // seen — on an onboard camera, straight over the car's own nose. Filling an
  // interior gap is the fit doing its job; extending past both ends of the
  // evidence is inventing road, which is the failure mode this whole pipeline
  // is built to avoid.
  let first = -1;
  let last = -1;
  for (let i = 0; i < ROWS; i++) {
    if (!rowFound[i]) continue;
    if (first < 0) first = i;
    last = i;
  }
  if (first < 0 || last - first < 6) return null;

  const left = new Float32Array(ROWS);
  const right = new Float32Array(ROWS);
  let widthSum = 0;

  for (let i = 0; i < ROWS; i++) {
    // Resample the fit across the measured span, so the output still has ROWS
    // entries but they cover only real road.
    const src = first + ((last - first) * i) / (ROWS - 1);
    const u = src / ROWS;
    let l = fitL[0] + fitL[1] * u + fitL[2] * u * u;
    let r = fitR[0] + fitR[1] * u + fitR[2] * u * u;
    // The fit is unconstrained and can cross over near the ends.
    if (r < l) [l, r] = [r, l];
    left[i] = clamp(l, 0, 1);
    right[i] = clamp(r, 0, 1);
    widthSum += right[i] - left[i];
  }

  const meanWidth = widthSum / ROWS;
  if (meanWidth < opts.minWidth) return null;

  const span = last - first + 1;

  return {
    yTop: rowY[first] / h,
    yBot: rowY[last] / h,
    left,
    right,
    // Fraction of the *reported* span that was measured rather than filled in,
    // which is what a caller deciding whether to trust it actually wants.
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
 *
 * Not every frame, and that is the point. A road does not move between two
 * frames 40 ms apart — a camera pans, a car turns in, and both happen over
 * hundreds of milliseconds. Re-tracing at frame rate would spend the latency
 * budget re-deriving a shape that has not changed, on the one path the whole
 * pipeline is built to keep under 100 ms.
 *
 * Between traces the last corridor is used as-is, so the wetness readout still
 * updates on every frame; only the shape it is measured through holds still.
 */
const RETRACE_MS = 250;

/** Blend factor toward a new trace. Low enough that one bad frame cannot jump the corridor. */
const TRACK_ALPHA = 0.35;

/** Below this the trace is not trusted enough to measure through. */
const MIN_CONFIDENCE = 0.55;

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
 * Keeps a lane trace alive across frames.
 *
 * Two jobs beyond calling `traceLane`: rate-limiting it so it costs nothing on
 * the hot path, and smoothing successive traces so the corridor tracks the road
 * instead of twitching every time a car crosses it. A corridor that moves a few
 * per cent per frame would make the racing-line band a different strip of tarmac
 * each time, and the divergence signal — the entire basis of the dry-line call —
 * is a comparison between two strips that are supposed to stay put.
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
   * Offer a frame. Returns the corridor to measure through, which may be the
   * previous one if this frame was skipped or the trace failed.
   */
  update(img: ImageData, now = performance.now()): LaneTrace | null {
    if (!this.enabled) return this.current;
    if (now - this.lastAttempt < RETRACE_MS) return this.current;
    this.lastAttempt = now;

    const t0 = performance.now();
    const fresh = traceLane(img, this.options);
    this.cost = performance.now() - t0;

    if (!fresh || fresh.confidence < MIN_CONFIDENCE) {
      this.misses++;
      // Hold the last good corridor for a few seconds. A car crossing the
      // frame, a burst of spray or a moment of glare will fail a trace, and
      // dropping the ROI for that would blank the readout at exactly the
      // moment someone is watching it. Past that, admit it is lost rather
      // than keep measuring through a corridor that no longer describes
      // anything in the picture.
      if (this.misses > 12) this.current = null;
      return this.current;
    }

    this.misses = 0;
    this.current = this.current ? blend(this.current, fresh, TRACK_ALPHA) : fresh;
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
