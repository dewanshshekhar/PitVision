import type { Signals } from '../types';
import type { Calibration } from './calibration';

/**
 * Offline pre-warm seed, produced by ml/scripts/calibrate.py.
 *
 * Copy the file that script writes into public/calibration.json and it is
 * fetched once at startup: anchors land before any footage loads, so the very
 * first frames of a fresh clip are scored against measured numbers instead of
 * the synthetic-scene defaults. The in-app real-time calibration then refines
 * from there on the actual feed.
 *
 * Absent or malformed file → null, silently. A missing seed is the normal
 * case, never an error worth surfacing.
 */
interface PreWarmFile {
  dry?: Partial<Signals>;
  wet?: Partial<Signals>;
  glareV?: number;
  glareS?: number;
  tracer?: { maxSat?: number; lumaTolerance?: number };
}

function isSignals(s: unknown): s is Signals {
  if (!s || typeof s !== 'object') return false;
  const v = s as Record<string, unknown>;
  return (['glare', 'texture', 'darkness', 'specular'] as const).every((k) =>
    Number.isFinite(v[k]),
  );
}

export async function loadPreWarmSeed(
  url = '/calibration.json',
): Promise<Partial<Calibration> | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const j = (await res.json()) as PreWarmFile;
    if (!isSignals(j.dry) || !isSignals(j.wet)) return null;

    const seed: Partial<Calibration> = { dry: { ...j.dry }, wet: { ...j.wet } };
    if (Number.isFinite(j.glareV)) seed.glareV = j.glareV;
    if (Number.isFinite(j.glareS)) seed.glareS = j.glareS;

    const t = j.tracer;
    if (t && Number.isFinite(t.maxSat) && Number.isFinite(t.lumaTolerance)) {
      seed.traceMaxSat = t.maxSat;
      seed.traceLumaTolerance = t.lumaTolerance;
    }
    return seed;
  } catch {
    return null;
  }
}
