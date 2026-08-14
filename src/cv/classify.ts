import type { Condition } from '../types';
import type { Calibration } from './calibration';

export interface ClassifyInput {
  wetness: number;
  line: number;
  edge: number;
  /** Wetness index change per minute */
  trend: number;
  /** Mean luma of the road ROI, 0..255 — separates Sunny from merely Dry. */
  luma: number;
  /** Specular fraction, 0..1 — a bright *and* glinting surface is sunlit. */
  glare: number;
}

export interface Band {
  condition: Condition;
  /** Lower bound on the wetness index, inclusive. */
  from: number;
  label: string;
}

/**
 * Bands on the wetness index.
 *
 * The boundaries are placed where a strategist's decision actually changes,
 * not at round numbers: Greasy is the range where slicks still work but the
 * surface has lost its bite, Damp is where intermediates start to pay, and
 * Flooded is where standing water makes aquaplaning the governing risk rather
 * than grip.
 */
export const BANDS: Band[] = [
  { condition: 'Flooded', from: 80, label: 'Standing water' },
  { condition: 'Wet', from: 55, label: 'Wet' },
  { condition: 'Damp', from: 34, label: 'Damp' },
  { condition: 'Greasy', from: 18, label: 'Slight wet / greasy' },
  { condition: 'Dry', from: 0, label: 'Dry' },
];

/** Above this luma, with visible glint and a dry index, the track is sunlit. */
const SUNNY_LUMA = 140;
const SUNNY_GLARE = 0.01;
const SUNNY_MAX_INDEX = 10;

export function bandFor(index: number): Band {
  return BANDS.find((b) => index >= b.from) ?? BANDS[BANDS.length - 1];
}

/**
 * Maps the wetness index onto a condition label.
 *
 * Two things stop the label from strobing on a noisy feed: a hysteresis margin
 * (a boundary must be over-crossed before the label flips) and a hold counter
 * (the candidate label has to survive several consecutive ticks). Both are
 * exposed in the calibration panel.
 */
export class ConditionClassifier {
  private current: Condition = 'Dry';
  private candidate: Condition = 'Dry';
  private held = 0;

  constructor(private cal: Calibration) {}

  setCalibration(c: Calibration) {
    this.cal = c;
  }

  get condition(): Condition {
    return this.current;
  }

  reset(to: Condition = 'Dry') {
    this.current = to;
    this.candidate = to;
    this.held = 0;
  }

  private instant(i: ClassifyInput): Condition {
    const { divergenceAt, hysteresis } = this.cal;
    const divergence = i.edge - i.line;

    // The dry line: the swept centre is measurably drier than the edges, the
    // surface is not already fully dry, and conditions are not deteriorating.
    //
    // Gated on the edge bands genuinely watching road. On a cockpit-mounted
    // camera they cannot — the car's front wheels occlude the track edges — and
    // comparing tarmac against a tyre would produce a confident, permanent and
    // completely fictional "dry line".
    if (
      this.cal.divergenceReliable &&
      divergence >= divergenceAt &&
      i.wetness >= 14 &&
      i.trend <= 2
    ) {
      return 'Drying';
    }

    // Hysteresis: leaving a band costs more than confirming it. Applied against
    // the band the label currently sits in, so the index has to move past the
    // boundary by the margin before anything changes.
    const currentBand = BANDS.findIndex((b) => b.condition === this.current);
    const band = BANDS.find((b, idx) => {
      // Moving up the scale (wetter) needs the margin added; moving down needs
      // it subtracted.
      const wetter = currentBand >= 0 && idx < currentBand;
      const bound = wetter ? b.from + hysteresis : b.from - hysteresis;
      return i.wetness >= bound;
    });
    const label = band?.condition ?? 'Dry';

    if (label === 'Dry' && i.luma >= SUNNY_LUMA && i.glare >= SUNNY_GLARE && i.wetness <= SUNNY_MAX_INDEX) {
      return 'Sunny';
    }
    return label;
  }

  update(i: ClassifyInput): Condition {
    const next = this.instant(i);
    if (next === this.current) {
      this.candidate = next;
      this.held = 0;
      return this.current;
    }
    if (next === this.candidate) {
      this.held++;
      if (this.held >= this.cal.holdTicks) {
        this.current = next;
        this.held = 0;
      }
    } else {
      this.candidate = next;
      this.held = 1;
    }
    return this.current;
  }
}
