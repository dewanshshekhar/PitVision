import type { Condition } from '../types';

/**
 * Expected lap-time penalty by surface condition, as a percentage of dry pace.
 *
 * Anchored on published figures rather than invented:
 *
 * - Pirelli's own crossover rule is that slicks give way to intermediates once
 *   lap time rises to **110–112%** of dry pace. That fixes the Damp band.
 * - Running intermediates when slicks are the right call costs **5–6 s/lap**;
 *   once a dry line exists slicks are **8–12 s/lap** faster than inters. Those
 *   bracket the Drying and Greasy bands.
 * - Full wets are reported around **6–7 s/lap slower than intermediates**,
 *   which on a typical 90 s lap puts standing-water running near 120%+.
 *
 * These are *class averages across circuits and eras*, not a prediction for a
 * specific car. A high-downforce circuit loses more in the wet than a
 * low-downforce one, and the spread between drivers in the wet is far wider
 * than in the dry. Treat the number as a bracket, which is why a range is
 * carried alongside the midpoint and shown in the UI.
 */
export interface LapModel {
  /** Midpoint multiplier on dry pace. 1.0 = dry reference. */
  factor: number;
  /** Plausible range, same units — real spread is wide and worth showing. */
  range: [number, number];
  tyre: string;
  note: string;
}

export const LAP_MODEL: Record<Condition, LapModel> = {
  Sunny: {
    factor: 1.0,
    range: [0.998, 1.004],
    tyre: 'Slick',
    note: 'Reference pace. A baking surface can flatter the softer compounds slightly.',
  },
  Dry: {
    factor: 1.0,
    range: [1.0, 1.008],
    tyre: 'Slick',
    note: 'Reference pace for the circuit.',
  },
  Greasy: {
    factor: 1.035,
    range: [1.02, 1.06],
    tyre: 'Slick (marginal)',
    note: 'Slicks still the quicker tyre, but the surface has lost its bite. Inters would cost time.',
  },
  Damp: {
    factor: 1.11,
    range: [1.10, 1.12],
    tyre: 'Intermediate',
    note: "Pirelli's crossover band — at 110–112% of dry pace intermediates become the quicker tyre.",
  },
  Wet: {
    factor: 1.16,
    range: [1.13, 1.20],
    tyre: 'Intermediate / full wet',
    note: 'Inters past their best; full wets closing in as water depth grows.',
  },
  Flooded: {
    factor: 1.24,
    range: [1.20, 1.35],
    tyre: 'Full wet',
    note: 'Standing water. Aquaplaning, not grip, is the governing risk — and the trigger for a safety car.',
  },
  Drying: {
    factor: 1.08,
    range: [1.03, 1.14],
    tyre: 'Inter → slick crossover',
    note: 'Falling fast as the line rubbers in. Slicks are 8–12 s/lap quicker than inters once the dry line carries them.',
  },
};

export interface LapEstimate {
  /** Estimated lap time in seconds at the current condition. */
  seconds: number;
  low: number;
  high: number;
  /** Delta against the dry baseline, seconds. */
  delta: number;
  deltaLow: number;
  deltaHigh: number;
  model: LapModel;
}

export function estimateLap(baselineSeconds: number, condition: Condition): LapEstimate {
  const m = LAP_MODEL[condition];
  const seconds = baselineSeconds * m.factor;
  const low = baselineSeconds * m.range[0];
  const high = baselineSeconds * m.range[1];
  return {
    seconds,
    low,
    high,
    delta: seconds - baselineSeconds,
    deltaLow: low - baselineSeconds,
    deltaHigh: high - baselineSeconds,
    model: m,
  };
}

/** m:ss.mmm, the way a timing screen shows it. */
export function formatLap(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return m > 0 ? `${m}:${s.toFixed(3).padStart(6, '0')}` : s.toFixed(3);
}

export function formatDelta(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const sign = seconds >= 0 ? '+' : '−';
  return `${sign}${Math.abs(seconds).toFixed(3)}`;
}
