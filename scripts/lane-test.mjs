/**
 * Lane tracer tests, headless.
 *
 * The tracer is the piece most likely to be subtly wrong, and "it compiles"
 * proves nothing about whether it follows a road. These build synthetic frames
 * with known geometry and check the trace against it.
 *
 * Synthetic scenes are not footage and passing here is not proof it works on a
 * wet Montreal onboard. What they do prove is the part that is checkable: that
 * it follows a curve rather than fitting a box, that it refuses when there is
 * no road, and that the things known to break the old fixed trapezoid — grass,
 * kerbs, a car in frame — do not pull it off the tarmac.
 *
 *   node scripts/lane-test.mjs
 */

import { traceLane, DEFAULT_TRACE_OPTIONS, ROWS } from '../src/cv/lane.ts';

const W = 384;
const H = 216;

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(t) {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

// Deterministic noise, so a failure is reproducible.
let seed = 12345;
function rnd() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}

/**
 * Build a frame containing a road whose boundaries are given by functions of
 * normalised depth. Everything outside the road is grass; above the horizon is
 * sky.
 */
function scene({ leftAt, rightAt, horizon = 0.36, roadLuma = 118, opts = {} }) {
  const data = new Uint8ClampedArray(W * H * 4);
  const put = (x, y, r, g, b) => {
    const i = (y * W + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  };

  for (let y = 0; y < H; y++) {
    const ny = y / H;
    for (let x = 0; x < W; x++) {
      const nx = x / W;
      if (ny < horizon) {
        // Sky: bright and strongly coloured.
        put(x, y, 120, 165, 225);
        continue;
      }
      const t = (ny - horizon) / (1 - horizon);
      const l = leftAt(t);
      const r = rightAt(t);
      if (nx >= l && nx <= r) {
        // Tarmac: grey, mid-bright, aggregate speckle.
        const n = (rnd() - 0.5) * 26;
        const v = roadLuma + n;
        put(x, y, v, v, v * 1.01);
      } else {
        // Grass: green and much noisier.
        const n = (rnd() - 0.5) * 40;
        put(x, y, 58 + n, 104 + n, 44 + n);
      }
    }
  }

  const img = { width: W, height: H, data };
  return { img, trace: traceLane(img, { ...DEFAULT_TRACE_OPTIONS, ...opts }) };
}

/** Ground-truth boundary at the same depth the trace reports for row i. */
function truthAt(fn, trace, i, horizon = 0.36) {
  const ny = trace.yTop + ((trace.yBot - trace.yTop) * i) / (ROWS - 1);
  const t = (ny - horizon) / (1 - horizon);
  return fn(Math.max(0, Math.min(1, t)));
}

/** Mean absolute error of both boundaries against the truth, in normalised x. */
function boundaryError(trace, leftAt, rightAt, horizon = 0.36) {
  let sum = 0;
  let n = 0;
  // Skip the extreme far rows: the fit extrapolates there and the road is only
  // a few pixels wide, so the truth itself is barely resolvable.
  for (let i = 6; i < ROWS - 2; i++) {
    sum += Math.abs(trace.left[i] - truthAt(leftAt, trace, i, horizon));
    sum += Math.abs(trace.right[i] - truthAt(rightAt, trace, i, horizon));
    n += 2;
  }
  return sum / n;
}

// ── Straight road ──────────────────────────────────────────────────────
section('A straight road');
{
  const leftAt = (t) => 0.5 - (0.06 + 0.30 * t);
  const rightAt = (t) => 0.5 + (0.06 + 0.30 * t);
  const { trace } = scene({ leftAt, rightAt });

  check('the road is found', trace !== null);
  if (trace) {
    const err = boundaryError(trace, leftAt, rightAt);
    check('boundaries land within 3% of the truth', err < 0.03, `mean error ${(err * 100).toFixed(1)}%`);
    check('most rows are measured, not extrapolated', trace.confidence > 0.75, `confidence ${trace.confidence.toFixed(2)}`);
    check('the traced surface reads as grey', trace.surfaceSat < 0.12, `sat ${trace.surfaceSat.toFixed(3)}`);
    check('the corridor widens toward the camera', trace.right[ROWS - 1] - trace.left[ROWS - 1] > trace.right[4] - trace.left[4]);
  }
}

// ── Curved road: the case a trapezoid cannot represent ─────────────────
section('A road that curves — what a fixed trapezoid cannot follow');
{
  // Centre swings 22% of frame width across the depth of the shot.
  const centre = (t) => 0.5 + 0.22 * t * t;
  const half = (t) => 0.07 + 0.24 * t;
  const leftAt = (t) => centre(t) - half(t);
  const rightAt = (t) => centre(t) + half(t);
  const { trace } = scene({ leftAt, rightAt });

  check('the curved road is found', trace !== null);
  if (trace) {
    const err = boundaryError(trace, leftAt, rightAt);
    check('the trace follows the curve within 3%', err < 0.03, `mean error ${(err * 100).toFixed(1)}%`);

    // The point of the whole exercise: the centre must actually move.
    const nearC = (trace.left[ROWS - 2] + trace.right[ROWS - 2]) / 2;
    const farC = (trace.left[6] + trace.right[6]) / 2;
    check('the traced centre moves with the corner', Math.abs(nearC - farC) > 0.08,
      `far ${farC.toFixed(2)} → near ${nearC.toFixed(2)}`);

    // A straight-sided box spanning the same rows would have to include
    // everything between the extremes of the curve, most of which is grass.
    let traced = 0;
    let boxed = 0;
    let minL = 1, maxR = 0;
    for (let i = 0; i < ROWS; i++) {
      traced += trace.right[i] - trace.left[i];
      minL = Math.min(minL, trace.left[i]);
      maxR = Math.max(maxR, trace.right[i]);
    }
    boxed = (maxR - minL) * ROWS;
    check('the trace is materially tighter than its bounding box', traced < boxed * 0.85,
      `traced ${(traced / ROWS).toFixed(3)} vs box ${(boxed / ROWS).toFixed(3)} per row`);
  }
}

// ── Refusal ────────────────────────────────────────────────────────────
section('It refuses rather than inventing a road');
{
  // All grass, no tarmac anywhere.
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const n = (rnd() - 0.5) * 40;
    data[i * 4] = 58 + n; data[i * 4 + 1] = 104 + n; data[i * 4 + 2] = 44 + n; data[i * 4 + 3] = 255;
  }
  const trace = traceLane({ width: W, height: H, data }, DEFAULT_TRACE_OPTIONS);
  check('a field of grass traces nothing', trace === null, trace ? `got width ${trace.meanWidth.toFixed(2)}` : '');
}
{
  // Pure sky.
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = 120; data[i * 4 + 1] = 165; data[i * 4 + 2] = 225; data[i * 4 + 3] = 255;
  }
  const trace = traceLane({ width: W, height: H, data }, DEFAULT_TRACE_OPTIONS);
  check('an empty sky traces nothing', trace === null);
}

// ── The things that broke the fixed trapezoid ──────────────────────────
section('Kerbs, markings and bodywork do not pull it off the tarmac');
{
  // Road with red/white kerbing painted along both edges. Kerbing is the
  // classic failure: bright and desaturated, it reads as specular reflection
  // and fabricates a dry line that is not there.
  const leftAt = (t) => 0.5 - (0.07 + 0.28 * t);
  const rightAt = (t) => 0.5 + (0.07 + 0.28 * t);
  const { img, trace } = scene({ leftAt, rightAt });

  const data = img.data;
  for (let y = 0; y < H; y++) {
    const ny = y / H;
    if (ny < 0.36) continue;
    const t = (ny - 0.36) / (1 - 0.36);
    const kerbW = Math.max(2, Math.round(0.03 * W));
    const paint = (px) => {
      for (let k = 0; k < kerbW; k++) {
        const x = px + k;
        if (x < 0 || x >= W) continue;
        const i = (y * W + x) * 4;
        const red = ((y >> 3) + k) % 2 === 0;
        data[i] = red ? 198 : 238; data[i + 1] = red ? 46 : 238; data[i + 2] = red ? 40 : 238;
      }
    };
    paint(Math.round(leftAt(t) * W) - kerbW);
    paint(Math.round(rightAt(t) * W));
  }

  const kerbed = traceLane(img, DEFAULT_TRACE_OPTIONS);
  check('road with kerbing is still found', kerbed !== null);
  if (kerbed) {
    const err = boundaryError(kerbed, leftAt, rightAt);
    check('the trace stops at the tarmac, not past the kerb', err < 0.035, `mean error ${(err * 100).toFixed(1)}%`);
  }
}
{
  // A white line painted across the road — the trace must span it, not stop.
  const leftAt = (t) => 0.5 - (0.07 + 0.28 * t);
  const rightAt = (t) => 0.5 + (0.07 + 0.28 * t);
  const { img } = scene({ leftAt, rightAt });
  const data = img.data;
  for (let y = 0; y < H; y++) {
    const ny = y / H;
    if (ny < 0.36) continue;
    const t = (ny - 0.36) / (1 - 0.36);
    const cx = Math.round(0.5 * W);
    const half = Math.max(1, Math.round(0.006 * W));
    if (rightAt(t) < 0.5 || leftAt(t) > 0.5) continue;
    for (let x = cx - half; x <= cx + half; x++) {
      const i = (y * W + x) * 4;
      data[i] = 240; data[i + 1] = 240; data[i + 2] = 240;
    }
  }
  const lined = traceLane(img, DEFAULT_TRACE_OPTIONS);
  check('a painted line does not split the corridor', lined !== null);
  if (lined) {
    const err = boundaryError(lined, leftAt, rightAt);
    check('the corridor still spans the full road', err < 0.035, `mean error ${(err * 100).toFixed(1)}%`);
  }
}
{
  // Onboard view: the car's own bodywork fills the bottom of the frame. The
  // old fixed trapezoid assumed road was in the lower half and measured the
  // car instead. The trace must lock onto the road above it.
  const leftAt = (t) => 0.5 - (0.07 + 0.30 * t);
  const rightAt = (t) => 0.5 + (0.07 + 0.30 * t);
  const { img } = scene({ leftAt, rightAt });
  const data = img.data;
  const noseTop = Math.round(0.72 * H);
  for (let y = noseTop; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      // Strongly coloured livery — the giveaway that it is not asphalt.
      data[i] = 208; data[i + 1] = 28; data[i + 2] = 32;
    }
  }
  const onboard = traceLane(img, DEFAULT_TRACE_OPTIONS);
  check('the road above the bodywork is found', onboard !== null);
  if (onboard) {
    // Every traced row must sit on tarmac, not on the nose.
    let onCar = 0;
    for (let i = 0; i < ROWS; i++) {
      const ny = onboard.yTop + ((onboard.yBot - onboard.yTop) * i) / (ROWS - 1);
      const cx = Math.round(((onboard.left[i] + onboard.right[i]) / 2) * W);
      const y = Math.round(ny * H);
      if (y < noseTop) continue;
      const p = (Math.min(H - 1, y) * W + cx) * 4;
      // Red channel far above green means livery, not asphalt.
      if (data[p] - data[p + 1] > 60) onCar++;
    }
    check('no traced row sits on the car', onCar === 0, `${onCar} rows on bodywork`);
  }
}

// ── Standing water, which is the thing it exists to measure ────────────
section('A sheet of standing water does not truncate the trace');
{
  // Water reflecting the sky is far brighter than the dry tarmac a few metres
  // nearer. The scan carries a brightness reference from the row below, and a
  // band that spans the full width across several rows accepts nothing — so
  // the reference never adapts and the trace used to stop dead, precisely at
  // the standing water it exists to measure.
  const leftAt = (t) => 0.5 - (0.07 + 0.28 * t);
  const rightAt = (t) => 0.5 + (0.07 + 0.28 * t);
  const dry = scene({ leftAt, rightAt });

  const { img } = scene({ leftAt, rightAt });
  const data = img.data;
  for (let y = 0; y < H; y++) {
    const ny = y / H;
    if (ny < 0.50 || ny > 0.66) continue;
    const t = (ny - 0.36) / (1 - 0.36);
    const x0 = Math.round(leftAt(t) * W);
    const x1 = Math.round(rightAt(t) * W);
    for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) {
      const i = (y * W + x) * 4;
      // Bright, near-colourless, and smooth — a mirror of the sky.
      const v = 236 + (rnd() - 0.5) * 6;
      data[i] = v; data[i + 1] = v; data[i + 2] = v * 1.01;
    }
  }

  const wet = traceLane(img, DEFAULT_TRACE_OPTIONS);
  check('the wet road is still traced', wet !== null);
  if (wet && dry.trace) {
    check(
      'the trace spans the water rather than stopping at it',
      wet.yBot - wet.yTop > (dry.trace.yBot - dry.trace.yTop) * 0.8,
      `wet span ${(wet.yBot - wet.yTop).toFixed(3)} vs dry ${(dry.trace.yBot - dry.trace.yTop).toFixed(3)}`,
    );
    check(
      'the water is inside the corridor, not outside it',
      wet.yTop <= 0.50 && wet.yBot >= 0.66,
      `corridor ${wet.yTop.toFixed(2)}–${wet.yBot.toFixed(2)}, water 0.50–0.66`,
    );
  }

  // The other half of the same trade: relaxing brightness must not let a
  // blown-out sky in, because that is desaturated too.
  const blown = scene({ leftAt, rightAt });
  const bd = blown.img.data;
  for (let y = 0; y < Math.floor(0.36 * H); y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      bd[i] = 255; bd[i + 1] = 255; bd[i + 2] = 255;
    }
  }
  const skyTrace = traceLane(blown.img, DEFAULT_TRACE_OPTIONS);
  check('a blown-out sky is still excluded', skyTrace !== null && skyTrace.yTop >= 0.36,
    skyTrace ? `yTop ${skyTrace.yTop.toFixed(3)}` : 'no trace');
}

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
