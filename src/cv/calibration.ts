import type { Signals } from '../types';
import { clamp, normalise } from '../util/math';
import { DEFAULT_ROAD, type RoadGeometry } from './rois';

export interface Calibration {
  /** Raw signal values sampled from known-dry footage */
  dry: Signals;
  /** Raw signal values sampled from known-wet footage */
  wet: Signals;
  /** Relative contribution of each signal to the wetness index. Normalised at use. */
  weights: Signals;
  glareV: number;
  glareS: number;
  /** Wetness index boundaries */
  dampAt: number;
  wetAt: number;
  /** Minimum edge-minus-line gap that counts as a drying line */
  divergenceAt: number;
  /** Extra margin a boundary must be crossed by before the label flips */
  hysteresis: number;
  /** Consecutive ticks a new label must hold before it is committed */
  holdTicks: number;
  /** EMA factor, 0..1. Lower = smoother, slower. */
  smoothing: number;
  road: RoadGeometry;
  aiIntervalSec: number;
  aiEnabled: boolean;
  /**
   * Whether the edge bands are actually looking at the same road surface as the
   * racing line. False on camera angles where they cannot be — a cockpit POV
   * has the car's own front wheels sitting exactly where the track edges would
   * be. When false, drying detection is disabled rather than fabricated.
   */
  divergenceReliable: boolean;
  /**
   * Which feed these anchors were measured on.
   *
   * Anchors are only meaningful for the footage they came from. Without this,
   * calibration from a previous clip — or from the generated scene — silently
   * persists through localStorage and gets applied to whatever is loaded next,
   * so a fresh clip is scored against a stranger's numbers and reports
   * confident nonsense.
   */
  signature: string;
}

/**
 * Starting anchors, measured off the synthetic scene held at its dry and wet
 * extremes. They are not magic numbers and they are not expected to survive
 * contact with real footage — the two Sample buttons overwrite them with
 * values taken from the actual clip, which is the entire point of the
 * calibration pass. They exist so the app is usable the moment it loads.
 *
 * Note the texture anchors run backwards (dry is *higher*): water fills the
 * voids in the aggregate and the surface stops scattering light. The
 * normaliser handles the inversion without a special case.
 */
export const DEFAULT_CALIBRATION: Calibration = {
  dry: { glare: 0.000, texture: 2050, darkness: 0.528, specular: 0.095 },
  wet: { glare: 0.058, texture: 640, darkness: 0.745, specular: 0.575 },
  weights: { glare: 0.35, texture: 0.25, darkness: 0.20, specular: 0.20 },
  glareV: 0.72,
  glareS: 0.22,
  dampAt: 24,
  wetAt: 52,
  divergenceAt: 9,
  hysteresis: 3,
  holdTicks: 6,
  smoothing: 0.16,
  road: { ...DEFAULT_ROAD },
  aiIntervalSec: 10,
  aiEnabled: true,
  divergenceReliable: true,
  signature: '',
};

const KEY = 'pitvision.calibration.v3';

export function loadCalibration(): Calibration {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_CALIBRATION);
    const parsed = JSON.parse(raw) as Partial<Calibration>;
    return {
      ...structuredClone(DEFAULT_CALIBRATION),
      ...parsed,
      dry: { ...DEFAULT_CALIBRATION.dry, ...parsed.dry },
      wet: { ...DEFAULT_CALIBRATION.wet, ...parsed.wet },
      weights: { ...DEFAULT_CALIBRATION.weights, ...parsed.weights },
      road: { ...DEFAULT_CALIBRATION.road, ...parsed.road },
    };
  } catch {
    return structuredClone(DEFAULT_CALIBRATION);
  }
}

export function saveCalibration(c: Calibration) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* private mode — calibration just won't persist */
  }
}

export function resetCalibration(): Calibration {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return structuredClone(DEFAULT_CALIBRATION);
}

/** Map raw signals onto 0..1 using the dry/wet anchors. */
export function normaliseSignals(s: Signals, c: Calibration): Signals {
  return {
    glare: normalise(s.glare, c.dry.glare, c.wet.glare),
    texture: normalise(s.texture, c.dry.texture, c.wet.texture),
    darkness: normalise(s.darkness, c.dry.darkness, c.wet.darkness),
    specular: normalise(s.specular, c.dry.specular, c.wet.specular),
  };
}

/**
 * The wetness index: a weighted fusion of the four normalised signals, 0..100.
 * Weights are renormalised on every call so the panel sliders can be dragged
 * freely without the index silently changing scale.
 */
/** Smallest anchor span that still carries information, per signal. */
const MIN_SPAN: Signals = { glare: 1e-4, texture: 1, darkness: 1e-3, specular: 1e-3 };

export function wetnessIndex(s: Signals, c: Calibration): number {
  const n = normaliseSignals(s, c);
  const keys: (keyof Signals)[] = ['glare', 'texture', 'darkness', 'specular'];

  // Only signals whose anchors actually separate can contribute, and the
  // weights are renormalised over those.
  //
  // Otherwise a signal with no measured span silently votes zero while still
  // holding its share of the weight. That is what happened on wet onboard
  // footage with no specular pixels anywhere in the ROI: glare had identical
  // dry and wet anchors, contributed nothing, and its 35% ceiling dragged a
  // soaked track down to an index of 65 — the other three signals were all
  // reading fully wet.
  let weighted = 0;
  let total = 0;
  for (const k of keys) {
    if (Math.abs(c.wet[k] - c.dry[k]) < MIN_SPAN[k]) continue;
    weighted += n[k] * c.weights[k];
    total += c.weights[k];
  }
  if (total <= 0) return 0;
  return clamp(weighted / total, 0, 1) * 100;
}

/** Signals whose calibration anchors are too close together to discriminate. */
export function inertSignals(c: Calibration): (keyof Signals)[] {
  const keys: (keyof Signals)[] = ['glare', 'texture', 'darkness', 'specular'];
  return keys.filter((k) => Math.abs(c.wet[k] - c.dry[k]) < MIN_SPAN[k]);
}
