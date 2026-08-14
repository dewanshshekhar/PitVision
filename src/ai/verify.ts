import type { Condition, Reading, Verification } from '../types';

export type VerifyStatus = 'idle' | 'checking' | 'ok' | 'offline' | 'error';

export interface VerifyState {
  status: VerifyStatus;
  message: string;
  last: Verification | null;
}

/**
 * Client for the AI verification proxy.
 *
 * This is deliberately a *second opinion*, not the detector. It runs on a slow
 * cadence, off the render path, and a failure here never touches the live CV
 * readout — the worst case is a stale "verified" chip.
 */
export class Verifier {
  private inFlight = false;
  private lastAt = 0;
  /** Set once the proxy tells us it has no key, so the timer stops hammering a 503. */
  private unconfigured = false;
  private listeners = new Set<(s: VerifyState) => void>();
  private state: VerifyState = { status: 'idle', message: 'Not yet run', last: null };

  onChange(fn: (s: VerifyState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<VerifyState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  get busy() {
    return this.inFlight;
  }

  get lastRunAt() {
    return this.lastAt;
  }

  /** False when the proxy has told us it has no key — auto-verification pauses. */
  get available() {
    return !this.unconfigured;
  }

  /** Called on a manual trigger, so adding a key mid-session recovers without a reload. */
  clearAvailability() {
    this.unconfigured = false;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch('/api/health');
      if (!res.ok) throw new Error(String(res.status));
      const j = (await res.json()) as { configured: boolean; model: string };
      if (!j.configured) {
        this.unconfigured = true;
        this.set({ status: 'offline', message: 'Proxy running, but ANTHROPIC_API_KEY is not set' });
        return false;
      }
      this.unconfigured = false;
      this.set({ status: 'idle', message: `Ready — ${j.model}` });
      return true;
    } catch {
      this.set({ status: 'offline', message: 'Verification proxy unreachable' });
      return false;
    }
  }

  async verify(image: string, reading: Reading): Promise<Verification | null> {
    if (this.inFlight) return null;
    this.inFlight = true;
    this.lastAt = Date.now();
    this.set({ status: 'checking', message: 'Second opinion in progress…' });

    const started = performance.now();
    try {
      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          image,
          cv: {
            condition: reading.condition,
            wetness: Math.round(reading.wetness),
            racingLine: Math.round(reading.line),
            trackEdges: Math.round(reading.edge),
            divergence: Math.round(reading.divergence),
            trendPerMin: Number(reading.trend.toFixed(1)),
          },
        }),
      });

      if (!res.ok) {
        const detail = await res.json().catch(() => null) as { error?: string } | null;
        const message = detail?.error ?? `Verification failed (${res.status})`;
        if (res.status === 503) {
          // No key on the proxy. Report it plainly and stop the auto-timer
          // rather than retrying a request that cannot succeed.
          this.unconfigured = true;
          this.set({ status: 'offline', message });
          return null;
        }
        throw new Error(message);
      }

      const body = (await res.json()) as {
        condition: Condition | 'Unknown';
        confidence: number;
        reasoning: string;
        model?: string;
      };

      const v: Verification = {
        condition: body.condition,
        confidence: body.confidence,
        reasoning: body.reasoning,
        agrees: body.condition === reading.condition,
        cvCondition: reading.condition,
        at: Date.now(),
        model: body.model,
        latencyMs: Math.round(performance.now() - started),
      };
      this.set({ status: 'ok', message: 'Verified', last: v });
      return v;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.set({
        status: msg.includes('Failed to fetch') ? 'offline' : 'error',
        message: msg.includes('Failed to fetch') ? 'Verification proxy unreachable' : msg,
      });
      return null;
    } finally {
      this.inFlight = false;
    }
  }
}
