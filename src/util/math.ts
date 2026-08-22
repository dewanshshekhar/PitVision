export const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Map a raw measurement onto 0..1 using two calibration anchors.
 * Works in both directions: if `wet < dry` (as it is for texture, which *falls*
 * when the surface is wet) the denominator goes negative and the mapping flips
 * automatically. No per-signal special-casing.
 */
export function normalise(raw: number, dry: number, wet: number): number {
  const span = wet - dry;
  if (Math.abs(span) < 1e-9) return 0;
  return clamp((raw - dry) / span);
}

/** Least-squares slope of y over t, in y-units per second. */
/**
 * Minimum span a fit must cover before its slope means anything, in seconds.
 *
 * A least-squares slope needs three points, and three points at 20 Hz span
 * 150 ms. Extrapolating that to a per-minute rate multiplies whatever noise sat
 * in those three samples by four hundred: a session that never moved past index
 * 7 reported a "fastest rise" of 266 points per minute, which is not a weather
 * event, it is the first fraction of a second of the fit.
 *
 * That number reached a session report as a headline figure, and a confidently
 * wrong number presented as a measurement is the exact failure this whole
 * pipeline is built to avoid. Two seconds is a quarter of the trend window: long
 * enough that a real change registers, short enough to still be responsive.
 */
const MIN_SLOPE_SPAN_SEC = 2;

/**
 * Least-squares slope of `ys` against `ts` (milliseconds), per second.
 *
 * Returns 0 — meaning "no trend established" — when the samples are too few or
 * cover too little time to support one. Zero is the safe answer: it raises no
 * alert, opens no incident, and reads on screen as a flat trend, which is what
 * "not enough evidence yet" should look like.
 */
export function slope(ts: number[], ys: number[]): number {
  const n = ts.length;
  if (n < 3) return 0;
  if ((ts[n - 1] - ts[0]) / 1000 < MIN_SLOPE_SPAN_SEC) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  const t0 = ts[0];
  for (let i = 0; i < n; i++) {
    const x = (ts[i] - t0) / 1000;
    sx += x; sy += ys[i]; sxx += x * x; sxy += x * ys[i];
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) return 0;
  return (n * sxy - sx * sy) / denom;
}

export const round = (v: number, dp = 1) => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};
