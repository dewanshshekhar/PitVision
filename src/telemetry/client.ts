import type { Calibration } from '../cv/calibration';
import type { Reading } from '../types';
import type { Alert } from '../ui/alerts';
import type { Check } from '../cv/prerace';
import type { Entrant } from '../ui/entrant';

/**
 * Telemetry client.
 *
 * Everything the detector produced used to live in this tab and die with it: a
 * 180-second ring buffer of readings, sixty alerts, one verification card. A
 * refresh, a crash or the end of the session and the evidence was gone — there
 * was no way to answer "what did it say at 14:32" ten minutes later, let alone
 * to check afterwards whether the detector had been trustworthy.
 *
 * This ships the same stream to the backend, which records it, watches it and
 * turns it into a report.
 *
 * Three rules govern the implementation, in order:
 *
 * 1. **It is never on the critical path.** Every method is fire-and-forget and
 *    swallows its own failures. The pipeline has a 100 ms end-to-end budget and
 *    a network round trip does not go inside it. If the backend is down the
 *    detector does not notice.
 * 2. **It downsamples before it sends.** The engine commits a reading per
 *    analysed frame — up to 25 a second. The weather does not move at 25 Hz;
 *    1 Hz preserves everything the trend window and the condition timeline are
 *    built from.
 * 3. **It buffers and retries.** Garage wifi drops. Readings queue while it is
 *    down and go out in the next batch rather than being lost.
 */

const SAMPLE_INTERVAL_MS = 1000;
const FLUSH_INTERVAL_MS = 5000;
/** Cap on the backlog. Beyond this the oldest go — a live readout beats a complete one. */
const MAX_QUEUE = 600;
const MAX_BATCH = 300;

export type TelemetryStatus = 'off' | 'connecting' | 'live' | 'retrying';

/** A finding the backend raised about the detector, not about the track. */
export interface Incident {
  id: number;
  kind: string;
  severity: 'warn' | 'critical';
  opened_at: number;
  closed_at: number | null;
  summary: string;
  detail: string | null;
}

export interface TelemetryState {
  status: TelemetryStatus;
  sessionId: string | null;
  queued: number;
  sent: number;
  message: string;
}

interface WireReading {
  t: number;
  wetness: number;
  wetnessRaw: number;
  line: number;
  edge: number;
  divergence: number;
  condition: string;
  trend: number;
  signals: Reading['signals'];
  normalised: Reading['normalised'];
  analysisMs: number;
  latencyMs?: number;
}

interface WireEvent {
  t: number;
  kind: string;
  level: string;
  title: string;
  detail?: string;
}

export class Telemetry {
  private sessionId: string | null = null;
  private readingQueue: WireReading[] = [];
  private eventQueue: WireEvent[] = [];
  private lastSampleAt = 0;
  private flushTimer = 0;
  private flushing = false;
  private sourceSignature = '';
  /**
   * What the lane tracer is doing.
   *
   * Sent with each batch because it decides what the readings *mean*: a lost
   * lane means the index is being measured through a corridor that no longer
   * describes anything in the picture, and the numbers keep arriving looking
   * exactly as confident as they did when it was locked.
   */
  private laneState: string = 'searching';
  private laneConfidence = 0;
  private sent = 0;
  private consecutiveFailures = 0;
  private stream: EventSource | null = null;

  /**
   * Called when the backend opens or closes an incident against this session.
   *
   * Without this the monitor was talking to itself. It watched the detector,
   * wrote its findings to a database and published them to anyone subscribed —
   * and the one tab that actually had a human in front of it was not
   * subscribed. A stalled feed, a calibration measured on different footage, a
   * vision model contradicting the detector on every frame: all correctly
   * detected, all invisible to the person making the tyre call.
   */
  onIncident: ((incident: Incident, state: 'opened' | 'closed') => void) | null = null;
  private listeners = new Set<(s: TelemetryState) => void>();
  private state: TelemetryState = {
    status: 'off',
    sessionId: null,
    queued: 0,
    sent: 0,
    message: 'No session',
  };

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  /** Stable across reloads, so several tabs on one bench are told apart. */
  private readonly clientId = clientId();

  get id() {
    return this.sessionId;
  }

  get active() {
    return this.sessionId !== null;
  }

  onChange(fn: (s: TelemetryState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<TelemetryState>) {
    this.state = {
      ...this.state,
      ...patch,
      sessionId: this.sessionId,
      queued: this.readingQueue.length + this.eventQueue.length,
      sent: this.sent,
    };
    for (const fn of this.listeners) fn(this.state);
  }

  private async post(path: string, body: unknown): Promise<Response | null> {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pitvision-client': this.clientId },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      return res;
    } catch {
      return null;
    }
  }

  /**
   * Open a session for the feed that has just loaded.
   *
   * A session is scoped to one feed. Loading a different clip ends the previous
   * one rather than continuing it, because the calibration anchors change with
   * the footage and a series scored against two different sets of anchors is
   * not one series.
   */
  async start(opts: {
    kind: string;
    label: string;
    signature: string;
    entrant: Entrant;
    baselineLapS: number;
  }): Promise<string | null> {
    if (this.sessionId) await this.end('feed changed');

    this.sourceSignature = opts.signature;
    this.set({ status: 'connecting', message: 'Opening session…' });

    const res = await this.post('/api/sessions', {
      source: { kind: opts.kind, label: opts.label, signature: opts.signature },
      entrant: {
        driver: opts.entrant.driver,
        number: opts.entrant.number,
        team: opts.entrant.team,
        car: opts.entrant.car,
        circuit: opts.entrant.circuit,
        session: opts.entrant.session,
      },
      baselineLapS: opts.baselineLapS,
      clientId: this.clientId,
      appVersion: '3.1.0',
    });

    if (!res) {
      this.set({ status: 'off', message: 'Backend unreachable — recording disabled' });
      return null;
    }

    const body = (await res.json()) as { session: { id: string } };
    this.sessionId = body.session.id;
    this.consecutiveFailures = 0;
    this.set({ status: 'live', message: `Recording — ${this.sessionId.slice(0, 12)}` });

    this.flushTimer = window.setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.listen(this.sessionId);
    return this.sessionId;
  }

  /**
   * Subscribe to this session's own stream, to hear what the backend has
   * noticed about it.
   *
   * Only `incident.*` is acted on. The stream also carries readings, pings and
   * calibration events — all of which this client is the one that *sent* — and
   * surfacing those would show every ping back to itself a second time.
   *
   * EventSource reconnects on its own, which is the reason for using it here: a
   * backend restart mid-session must not leave the pit wall silently unwatched
   * until someone reloads the page.
   */
  private listen(sessionId: string) {
    this.stream?.close();
    try {
      const es = new EventSource(`/api/sessions/${sessionId}/stream`);
      this.stream = es;

      const handle = (state: 'opened' | 'closed') => (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(ev.data) as { data: Incident };
          if (msg?.data) this.onIncident?.(msg.data, state);
        } catch {
          /* a malformed frame is not worth taking the session down for */
        }
      };

      es.addEventListener('incident.opened', handle('opened'));
      es.addEventListener('incident.closed', handle('closed'));
    } catch {
      // No EventSource, or the stream was refused. Recording is unaffected —
      // this only costs the live incident feed.
      this.stream = null;
    }
  }

  /**
   * Offer a reading. Most are dropped on the floor by design — see rule 2.
   * Called from the engine's reading listener, so it must be cheap and
   * synchronous: no awaits, no allocation beyond the sampled row.
   */
  /** Called every frame by the app; cheap, no allocation. */
  setLane(state: string, confidence: number) {
    this.laneState = state;
    this.laneConfidence = confidence;
  }

  observe(reading: Reading, latencyMs?: number) {
    if (!this.sessionId) return;
    if (reading.t - this.lastSampleAt < SAMPLE_INTERVAL_MS) return;
    this.lastSampleAt = reading.t;

    this.readingQueue.push({
      t: reading.t,
      wetness: round(reading.wetness),
      wetnessRaw: round(reading.wetnessRaw),
      line: round(reading.line),
      edge: round(reading.edge),
      divergence: round(reading.divergence),
      condition: reading.condition,
      trend: round(reading.trend),
      signals: reading.signals,
      normalised: reading.normalised,
      analysisMs: round(reading.ms),
      ...(latencyMs !== undefined ? { latencyMs: round(latencyMs) } : {}),
    });

    if (this.readingQueue.length > MAX_QUEUE) {
      this.readingQueue.splice(0, this.readingQueue.length - MAX_QUEUE);
    }
  }

  /**
   * A condition change is worth sending immediately rather than waiting out the
   * flush interval — it is the one thing a second screen is watching for, and
   * five seconds late is five seconds of a strategist not knowing.
   */
  observeConditionChange() {
    if (this.sessionId) void this.flush();
  }

  event(alert: Alert) {
    if (!this.sessionId) return;
    this.eventQueue.push({
      t: alert.t,
      kind: alert.kind,
      level: alert.level,
      title: alert.title,
      detail: alert.detail,
    });
    if (alert.level !== 'info') void this.flush();
  }

  /** Record a pre-race check outcome and the anchors it produced. */
  async calibration(args: {
    ok: boolean;
    checks: Check[];
    verdict: string | null;
    anchoring: string | null;
    cal: Calibration;
    signature: string;
  }) {
    if (!this.sessionId) return;
    this.sourceSignature = args.signature;
    await this.post(`/api/sessions/${this.sessionId}/calibration`, {
      ok: args.ok,
      verdict: args.verdict,
      anchoring: args.anchoring,
      divergenceReliable: args.cal.divergenceReliable,
      sourceSignature: args.signature,
      checks: args.checks.map((c) => ({ id: c.id, label: c.label, state: c.state, detail: c.detail })),
      anchors: { dry: args.cal.dry, wet: args.cal.wet, weights: args.cal.weights },
    });
  }

  private async flush() {
    if (!this.sessionId || this.flushing) return;
    if (this.readingQueue.length === 0 && this.eventQueue.length === 0) return;

    this.flushing = true;
    try {
      if (this.eventQueue.length > 0) {
        const batch = this.eventQueue.slice(0, 100);
        const res = await this.post(`/api/sessions/${this.sessionId}/events`, { events: batch });
        if (res) this.eventQueue.splice(0, batch.length);
      }

      if (this.readingQueue.length > 0) {
        const batch = this.readingQueue.slice(0, MAX_BATCH);
        const res = await this.post(`/api/sessions/${this.sessionId}/readings`, {
          readings: batch,
          sourceSignature: this.sourceSignature,
          lane: { state: this.laneState, confidence: this.laneConfidence },
        });
        if (res) {
          // Only drop what the server confirmed. A failed flush leaves the queue
          // intact so the next one carries it — the rows are idempotent on
          // (session, timestamp), so a retry that partly landed is harmless.
          this.readingQueue.splice(0, batch.length);
          this.sent += batch.length;
          this.consecutiveFailures = 0;
          this.set({ status: 'live', message: `Recording — ${this.sent} readings stored` });
        } else {
          this.consecutiveFailures++;
          this.set({
            status: 'retrying',
            message: `Backend unreachable — ${this.readingQueue.length} readings queued`,
          });
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  async end(reason: string) {
    const id = this.sessionId;
    if (!id) return null;

    window.clearInterval(this.flushTimer);
    this.flushTimer = 0;
    this.stream?.close();
    this.stream = null;
    await this.flush();

    this.sessionId = null;
    const res = await this.post(`/api/sessions/${id}/end`, { reason });
    this.readingQueue = [];
    this.eventQueue = [];
    this.lastSampleAt = 0;
    this.set({ status: 'off', message: 'Session closed' });

    return res ? ((await res.json()) as { report: unknown }).report : null;
  }

  /**
   * Close the session when the tab goes away.
   *
   * `sendBeacon` rather than fetch: the page is being torn down and a normal
   * request is cancelled with it. Without this every session would have to wait
   * out the server's idle timeout before being marked abandoned, and its report
   * would carry several minutes of silence on the end.
   */
  endOnUnload() {
    if (!this.sessionId) return;
    this.stream?.close();
    this.stream = null;
    const body = JSON.stringify({ reason: 'tab closed' });
    navigator.sendBeacon?.(
      `/api/sessions/${this.sessionId}/end`,
      new Blob([body], { type: 'application/json' }),
    );
  }
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function clientId(): string {
  const KEY = 'pitvision.clientId';
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const fresh = `web-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    return `web-${Math.random().toString(36).slice(2, 10)}`;
  }
}
