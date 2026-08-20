/**
 * The trend slope must not report a rate it cannot support.
 *
 *   node --import ./scripts/ts-resolve.mjs scripts/trend-test.mjs
 *
 * This exists because a real session report carried "fastest rise 266.7/min"
 * for a session whose wetness index never left the range 0–7.5. The figure came
 * from the first three samples of the least-squares fit, 150 ms apart at 20 Hz,
 * extrapolated to a per-minute rate. Nothing raised, nothing looked wrong, and
 * the number went into a report as a headline measurement.
 */

import { slope } from '../src/util/math.ts';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/** `n` samples at `hz`, rising by `perSec` index points per second. */
function ramp(n, hz, perSec, start = 0) {
  const ts = [], ys = [];
  for (let i = 0; i < n; i++) {
    ts.push(i * (1000 / hz));
    ys.push(start + (i / hz) * perSec);
  }
  return [ts, ys];
}

section('A fit too short to mean anything reports nothing');
{
  // The exact shape that produced 266.7/min: three samples at 20 Hz.
  const [ts, ys] = ramp(3, 20, 4.4);
  check('three samples 150 ms apart give 0, not a rate', slope(ts, ys) === 0,
    `${(slope(ts, ys) * 60).toFixed(1)}/min`);

  const [t2, y2] = ramp(20, 20, 4.4); // 1 second
  check('one second of samples still gives 0', slope(t2, y2) === 0,
    `${(slope(t2, y2) * 60).toFixed(1)}/min`);

  const [t3, y3] = ramp(2, 20, 4.4);
  check('fewer than three samples give 0', slope(t3, y3) === 0);
}

section('Once there is enough span, the rate is correct');
{
  // 3 s at 20 Hz, rising 0.5 index points per second = 30 per minute.
  const [ts, ys] = ramp(60, 20, 0.5);
  const perMin = slope(ts, ys) * 60;
  check('a 3 s window recovers the true rate', Math.abs(perMin - 30) < 0.5,
    `${perMin.toFixed(2)}/min, want 30`);

  const [td, yd] = ramp(60, 20, -0.5, 40);
  check('a falling trend is recovered too', Math.abs(slope(td, yd) * 60 + 30) < 0.5,
    `${(slope(td, yd) * 60).toFixed(2)}/min, want -30`);

  const [tf, yf] = ramp(60, 20, 0);
  check('a flat series reads flat', Math.abs(slope(tf, yf)) < 1e-6);
}

section('Noise on a short window cannot masquerade as weather');
{
  // Index wandering ±0.4 around 5, sampled fast. Whatever the fit makes of it,
  // it must not be published as a rate until the window has real span.
  let seed = 5;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  let worst = 0;
  for (let trial = 0; trial < 200; trial++) {
    const ts = [], ys = [];
    for (let i = 0; i < 30; i++) { ts.push(i * 50); ys.push(5 + (rnd() - 0.5) * 0.8); }
    worst = Math.max(worst, Math.abs(slope(ts, ys) * 60));
  }
  check('1.5 s of jitter never reports a rate', worst === 0, `worst ${worst.toFixed(1)}/min`);

  worst = 0;
  for (let trial = 0; trial < 200; trial++) {
    const ts = [], ys = [];
    for (let i = 0; i < 160; i++) { ts.push(i * 50); ys.push(5 + (rnd() - 0.5) * 0.8); }
    worst = Math.max(worst, Math.abs(slope(ts, ys) * 60));
  }
  // 8 s of the same jitter is the real trend window; the fit should stay small.
  check('8 s of the same jitter stays well under the surge threshold', worst < 14,
    `worst ${worst.toFixed(1)}/min, surge fires at 14`);
}

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
