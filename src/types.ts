/**
 * Surface states, ordered by how much water is on the track.
 *
 * `Drying` is not a point on that scale — it is a *shape*, fired when the
 * racing line reads meaningfully drier than the edges, and it outranks the
 * band label because the crossover is the more actionable call.
 *
 * `Sunny` and `Dry` describe the same grip; they are separated because a
 * strategist reads them differently — sunny means the surface is baking off
 * any moisture, dry alone does not.
 */
export type Condition =
  | 'Sunny'
  | 'Dry'
  | 'Greasy'
  | 'Damp'
  | 'Wet'
  | 'Flooded'
  | 'Drying';

/** Water-content order. `Drying` is excluded — it is orthogonal to the scale. */
export const CONDITION_SCALE: Condition[] = ['Sunny', 'Dry', 'Greasy', 'Damp', 'Wet', 'Flooded'];

/** Raw, un-normalised measurements for one region of interest. */
export interface BandMetrics {
  /** Mean luma, 0..255 */
  luma: number;
  /** Median luma, 0..255 */
  lumaP50: number;
  /** 95th percentile luma, 0..255 */
  lumaP95: number;
  /** Mean HSV saturation, 0..1 */
  sat: number;
  /** Fraction of pixels that are bright AND desaturated — specular reflection, 0..1 */
  glare: number;
  /** Variance of the 4-neighbour Laplacian — surface micro-texture */
  texture: number;
  /** (p95 - p50) / 255 — how far the specular highlights sit above the base surface */
  contrast: number;
  pixels: number;
}

/** The four raw signals the wetness index is built from. */
export interface Signals {
  /** Specular glare fraction. Wet ↑ */
  glare: number;
  /** Laplacian variance. Wet ↓ (water mirrors, hiding aggregate grain) */
  texture: number;
  /** 1 - mean luma. Wet ↑ (water darkens asphalt) */
  darkness: number;
  /** Highlight spread above the base surface. Wet ↑ */
  specular: number;
}

export interface FrameMetrics {
  road: BandMetrics;
  line: BandMetrics;
  left: BandMetrics;
  right: BandMetrics;
  /** Coarse per-cell glare fraction over the road ROI, -1 = outside ROI */
  heatGlare: Float32Array;
  /** Coarse per-cell mean luma over the road ROI, -1 = outside ROI */
  heatLuma: Float32Array;
  heatW: number;
  heatH: number;
  /** Wall-clock cost of the analysis pass, milliseconds */
  ms: number;
}

/** One fully-processed sample of the live feed. */
export interface Reading {
  t: number;
  /** Smoothed wetness index for the whole road ROI, 0..100 */
  wetness: number;
  /** Unsmoothed wetness index — shows the true per-frame noise */
  wetnessRaw: number;
  /** Smoothed wetness index of the racing line only */
  line: number;
  /** Smoothed wetness index of the track edges only */
  edge: number;
  /** edge - line. Positive means the line is drying faster than the edges. */
  divergence: number;
  condition: Condition;
  /** Wetness index change per minute, from a least-squares fit over the trend window */
  trend: number;
  signals: Signals;
  /** Normalised 0..1 signals after calibration — what actually feeds the index */
  normalised: Signals;
  ms: number;
}

export interface Verification {
  condition: Condition | 'Unknown';
  confidence: number;
  reasoning: string;
  agrees: boolean;
  cvCondition: Condition;
  at: number;
  model?: string;
  latencyMs?: number;
}
