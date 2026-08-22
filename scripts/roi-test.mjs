/**
 * Does the reading come only from the road?
 *
 * The tracer having found the road is not the same as the *measurement* being
 * confined to it. This checks the second thing, which is the one that decides
 * whether a number can be trusted: if sky, grass or a car can reach the
 * sampler, the index they produce is confidently wrong and looks exactly like
 * a correct one.
 *
 * The decisive test is not "does the region look right" — it is: change
 * everything outside the road, drastically, and prove the measured numbers do
 * not move at all.
 *
 *   node --import ./scripts/ts-resolve.mjs scripts/roi-test.mjs
 */

import { traceLane, DEFAULT_TRACE_OPTIONS, ROWS } from '../src/cv/lane.ts';
import { corridorFromTrace, corridorFromRoad, DEFAULT_ROAD, SUB_BANDS } from '../src/cv/rois.ts';
import { BAND_FILL_ORDER, BAND_STROKE_ORDER, BAND_STYLE } from '../src/ui/overlay-bands.ts';
import { analyseFrame } from '../src/cv/metrics.ts';

const W = 384;
const H = 216;
const HORIZON = 0.38;
const GLARE = { v: 0.72, s: 0.22 };

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

// ── Overlay semantics ─────────────────────────────────────────────────
section('The overlay maps the full road and its two sides');
{
  const byName = Object.fromEntries(SUB_BANDS.map((band) => [band.name, band]));
  check('the green road band spans the complete corridor',
    byName.road.u0 === 0 && byName.road.u1 === 1);
  check('the blue left band stays on the left edge',
    byName.left.u0 === 0 && byName.left.u1 < 0.5);
  check('the blue right band stays on the right edge',
    byName.right.u0 > 0.5 && byName.right.u1 === 1);
  check('the overlay draws road plus sides, not the narrow centre band',
    Boolean(BAND_STYLE.road && BAND_STYLE.left && BAND_STYLE.right && !BAND_STYLE.line));
  check('the green full-road outline is drawn after both blue edge outlines',
    BAND_STROKE_ORDER.at(-1) === 'road' && BAND_FILL_ORDER[0] === 'road');
}

let seed = 99;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

const leftAt = (t) => 0.5 - (0.07 + 0.28 * t);
const rightAt = (t) => 0.5 + (0.07 + 0.28 * t);

/**
 * @param sky  what to paint above the horizon
 * @param sun  add a blown-out sun-glint band on the road
 */
function build({ sky = 'normal', sun = false } = {}) {
  seed = 99; // identical road noise across variants, so any delta is the sky
  const data = new Uint8ClampedArray(W * H * 4);
  const put = (x, y, r, g, b) => {
    const i = (y * W + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  };

  for (let y = 0; y < H; y++) {
    const ny = y / H;
    for (let x = 0; x < W; x++) {
      const nx = x / W;
      if (ny < HORIZON) {
        if (sky === 'normal') put(x, y, 120, 165, 225);
        else if (sky === 'blown') put(x, y, 255, 255, 255);   // blown-out white sky
        else if (sky === 'sunset') put(x, y, 255, 120, 30);   // hard orange
        else put(x, y, 4, 4, 6);                              // night
        continue;
      }
      const t = (ny - HORIZON) / (1 - HORIZON);
      const l = leftAt(t), r = rightAt(t);
      if (nx >= l && nx <= r) {
        let v = 118 + (rnd() - 0.5) * 26;
        // A specular band across the middle distance — low sun on dry tarmac.
        if (sun && ny > 0.46 && ny < 0.56) v = 250;
        put(x, y, v, v, v * 1.01);
      } else {
        const n = (rnd() - 0.5) * 40;
        put(x, y, 58 + n, 104 + n, 44 + n);
      }
    }
  }
  return { width: W, height: H, data };
}

function measure(img) {
  const trace = traceLane(img, DEFAULT_TRACE_OPTIONS);
  if (!trace) return null;
  const m = analyseFrame(img, corridorFromTrace(trace), GLARE);
  return { trace, m };
}

// ── The corridor never reaches the sky ─────────────────────────────────
section('The traced corridor stops at the road');
{
  const { trace } = measure(build());
  check('the road is traced', !!trace);
  if (trace) {
    check(
      'no traced row sits above the horizon',
      trace.yTop >= HORIZON,
      `yTop ${trace.yTop.toFixed(3)} vs horizon ${HORIZON}`,
    );
    let aboveHorizon = 0;
    for (let i = 0; i < ROWS; i++) {
      const ny = trace.yTop + ((trace.yBot - trace.yTop) * i) / (ROWS - 1);
      if (ny < HORIZON) aboveHorizon++;
    }
    check('every sampled row is below the horizon', aboveHorizon === 0, `${aboveHorizon} rows above`);
  }
}

// ── The decisive one ───────────────────────────────────────────────────
section('Changing the sky does not change the reading');
{
  const base = measure(build({ sky: 'normal' }));
  check('baseline measured', base !== null);

  for (const sky of ['blown', 'sunset', 'night']) {
    const alt = measure(build({ sky }));
    if (!base || !alt) { check(`sky=${sky} measured`, false); continue; }

    const b = base.m.road;
    const a = alt.m.road;
    const same =
      Math.abs(a.luma - b.luma) < 0.01 &&
      Math.abs(a.glare - b.glare) < 1e-6 &&
      Math.abs(a.texture - b.texture) < 0.01 &&
      Math.abs(a.sat - b.sat) < 1e-6 &&
      a.pixels === b.pixels;

    check(
      `a ${sky} sky leaves every road metric identical`,
      same,
      `luma ${b.luma.toFixed(2)}→${a.luma.toFixed(2)}, glare ${b.glare.toFixed(4)}→${a.glare.toFixed(4)}, ` +
      `texture ${b.texture.toFixed(1)}→${a.texture.toFixed(1)}, px ${b.pixels}→${a.pixels}`,
    );
  }
}

// ── What the old fixed trapezoid did with the same frames ──────────────
section('The same frames through the fixed trapezoid, for comparison');
{
  const corridor = corridorFromRoad(DEFAULT_ROAD);
  const b = analyseFrame(build({ sky: 'normal' }), corridor, GLARE).road;
  const a = analyseFrame(build({ sky: 'blown' }), corridor, GLARE).road;
  // The default trapezoid starts at y=0.55, below this scene's horizon, so the
  // sky does not reach it here either — but it samples grass, which the trace
  // excludes. That is the difference worth showing.
  const traced = measure(build({ sky: 'normal' }));
  check(
    'the fixed region samples a more coloured surface than the trace',
    traced !== null && b.sat > traced.m.road.sat,
    traced ? `fixed sat ${b.sat.toFixed(3)} vs traced ${traced.m.road.sat.toFixed(3)}` : '',
  );
  check('(sky still excluded by the fixed region in this scene)', Math.abs(a.luma - b.luma) < 0.01);
}

// ── Sun glint on dry tarmac ────────────────────────────────────────────
section('Sun glint is measured, not mistaken for water on its own');
{
  const dry = measure(build());
  const glint = measure(build({ sun: true }));
  check('both measured', dry !== null && glint !== null);
  if (dry && glint) {
    // Glare must rise — it is a real specular signal and hiding it would be
    // its own kind of lie.
    check('glare rises with the glint', glint.m.road.glare > dry.m.road.glare,
      `${dry.m.road.glare.toFixed(4)} → ${glint.m.road.glare.toFixed(4)}`);
    // But the surface got *brighter*, not darker, and water darkens asphalt.
    // The joint test downstream is what stops this reading as wet; here we
    // just confirm the evidence it needs is present and pointing the right way.
    check('the surface reads brighter, not darker — the opposite of wet',
      glint.m.road.luma > dry.m.road.luma,
      `${dry.m.road.luma.toFixed(1)} → ${glint.m.road.luma.toFixed(1)}`);
  }
}

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
