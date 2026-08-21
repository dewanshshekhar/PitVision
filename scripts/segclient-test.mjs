/** Temporal contract for neural road segmentation. */

import { SegmentationClient, SEGMENT_INTERVAL_MS, MAX_SEGMENT_AGE_MS } from '../src/cv/segclient.ts';
import { ROWS } from '../src/cv/lane.ts';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const trace = (centre, at = 0) => ({
  yTop: 0.35,
  yBot: 0.72,
  left: Float32Array.from({ length: ROWS }, (_, i) => centre - 0.08 - 0.20 * i / (ROWS - 1)),
  right: Float32Array.from({ length: ROWS }, (_, i) => centre + 0.08 + 0.20 * i / (ROWS - 1)),
  confidence: 0.95,
  measuredRows: ROWS,
  meanWidth: 0.36,
  surfaceSat: 0,
  surfaceLuma: 0,
  at,
});
const wire = (centre) => ({
  yTop: 0.35,
  yBot: 0.72,
  left: Array.from(trace(centre).left),
  right: Array.from(trace(centre).right),
  confidence: 0.95,
  measuredRows: ROWS,
  meanWidth: 0.36,
  limitsFrom: 'mask_edge',
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const originalFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = async () => {
  requests++;
  return { json: async () => ({ corridor: wire(0.5) }) };
};

try {
  const client = new SegmentationClient();
  client.enabled = true;
  const straight = trace(0.5, 1000);
  client.update(() => 'frame', straight, 1000);
  await settle();

  const turning = trace(0.64, 1080);
  const moved = client.update(() => null, turning, 1080);
  check('a delayed neural corridor is propagated with the live turn', moved !== null);
  if (moved) {
    const i = Math.floor(ROWS / 2);
    const centre = (moved.left[i] + moved.right[i]) / 2;
    check('motion compensation follows the current road centre', Math.abs(centre - 0.64) < 0.015,
      `centre ${centre.toFixed(3)}`);
  }

  client.update(() => 'frame', turning, 1000 + SEGMENT_INTERVAL_MS - 1);
  check('requests are rate-limited without a 400 ms hold', requests === 1, `${requests} requests`);
  client.update(() => 'frame', turning, 1000 + SEGMENT_INTERVAL_MS + 1);
  await settle();
  check('a new semantic keyframe is requested promptly', requests === 2, `${requests} requests`);

  const expired = client.update(
    () => null,
    turning,
    1000 + SEGMENT_INTERVAL_MS + 1 + MAX_SEGMENT_AGE_MS + 2,
  );
  check('an expired neural frame yields to the current geometric tracer', expired === null);
} finally {
  globalThis.fetch = originalFetch;
}

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
