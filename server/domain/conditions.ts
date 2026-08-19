/**
 * The condition vocabulary, server side.
 *
 * This mirrors `src/types.ts`. It is duplicated rather than imported because
 * the server must be able to reject a bad label from a client that is running
 * an older build — importing the client's own definition would make the check
 * agree with whatever the client happened to send.
 */

export const CONDITIONS = [
  'Sunny',
  'Dry',
  'Greasy',
  'Damp',
  'Wet',
  'Flooded',
  'Drying',
] as const;

export type Condition = (typeof CONDITIONS)[number];

/** Water-content order. `Drying` is absent: it is a shape, not a point on the scale. */
export const CONDITION_SCALE: Condition[] = ['Sunny', 'Dry', 'Greasy', 'Damp', 'Wet', 'Flooded'];

export type AgreementLevel = 'match' | 'adjacent' | 'conflict' | 'unknown';

export function isCondition(v: unknown): v is Condition {
  return typeof v === 'string' && (CONDITIONS as readonly string[]).includes(v);
}

/**
 * How far apart two calls are, in bands. `null` when the pair cannot be placed
 * on one scale — anything involving `Drying`, which is orthogonal to it.
 */
export function bandDistance(a: Condition, b: Condition): number | null {
  const ia = CONDITION_SCALE.indexOf(a);
  const ib = CONDITION_SCALE.indexOf(b);
  if (ia < 0 || ib < 0) return null;
  return Math.abs(ia - ib);
}

/**
 * Grade a verification against the CV call.
 *
 * A boolean here was actively misleading. The old proxy offered the model a
 * five-value enum (`Dry|Damp|Wet|Drying|Unknown`) while the engine classifies
 * into seven, so whenever the CV engine said `Sunny`, `Greasy` or `Flooded`
 * the model *could not* return that string — every such frame was recorded as
 * a disagreement no matter what the model actually saw. The enum is now the
 * full set, and the grade distinguishes a real conflict from neighbouring
 * bands, which is the distinction a strategist cares about: Damp against Wet
 * is a judgement call, Dry against Flooded is a broken detector.
 */
export function grade(cv: Condition, ai: Condition | 'Unknown'): AgreementLevel {
  if (ai === 'Unknown') return 'unknown';
  if (cv === ai) return 'match';
  const d = bandDistance(cv, ai);
  // Drying vs a wet-scale label: treat the damp/wet neighbourhood as adjacent,
  // because a track with a forming dry line genuinely reads as damp in a single
  // frame that does not show the width of the circuit.
  if (d === null) {
    const other = cv === 'Drying' ? ai : cv;
    return other === 'Damp' || other === 'Greasy' || other === 'Wet' ? 'adjacent' : 'conflict';
  }
  return d === 1 ? 'adjacent' : 'conflict';
}

/** Whether a grade counts toward the agreement rate. `unknown` is abstention. */
export function isComparable(level: AgreementLevel): boolean {
  return level !== 'unknown';
}

/** Agreement credit: a neighbouring band is half a match, not a failure. */
export function agreementScore(level: AgreementLevel): number {
  if (level === 'match') return 1;
  if (level === 'adjacent') return 0.5;
  return 0;
}
