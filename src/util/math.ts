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
export function slope(ts: number[], ys: number[]): number {
  const n = ts.length;
  if (n < 3) return 0;
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
