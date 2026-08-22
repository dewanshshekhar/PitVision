/**
 * The monitor.
 *
 * This is the part that watches the detector rather than the track. The browser
 * already tells a strategist what the weather is doing; nothing until now told
 * anyone whether the thing producing that answer was still working.
 *
 * Every check here answers a question that has a wrong answer the UI would show
 * confidently:
 *
 * - Has the feed stopped? A frozen readout looks exactly like stable weather.
 * - Is the pipeline making its latency budget, or is the number on screen old?
 * - Is the CV engine and the vision model still agreeing? Sustained divergence
 *   means the calibration has drifted off the footage, and the index is being
 *   reported to three significant figures while it is wrong.
 * - Is verification failing? If so the "verified" chip is stale, not reassuring.
 * - Is the classifier strobing? That is a calibration fault, and it reaches a
 *   strategist as a sequence of contradictory pit calls.
 * - Is the calibration even the one measured on this footage?
 *
 * Findings become *incidents* with an open/closed lifecycle rather than log
 * lines, so "is anything wrong right now" is a single query. Each one closes
 * itself when the condition clears — a monitor that only ever raises alarms
 * gets muted within a day and then it is not a monitor.
 */

import type { Config, MonitorThresholds } from '../config.ts';
import type { Logger } from '../lib/log.ts';
import type { Store, SessionRow } from './store.ts';
import type { Bus } from './bus.ts';
import type { Metrics } from './metrics.ts';
import { agreementScore, type Condition } from '../domain/conditions.ts';

export type IncidentKind =
  | 'feed_stall'
  | 'latency_budget'
  | 'verification_drift'
  | 'verification_down'
  | 'condition_instability'
  | 'rapid_wetting'
  | 'calibration_mismatch'
  | 'lane_lost';

interface Flip {
  at: number;
  from: Condition;
  to: Condition;
}

/**
 * Per-session working state.
 *
 * Held in memory rather than recomputed from SQL on every tick: the sweep runs
 * every two seconds across every active session, and re-reading a rolling
 * latency window out of the database each time would make the monitor the most
 * expensive thing in the process.
 */
class SessionState {
  lastReadingAt = 0;
  lastReadingT = 0;
  lastCondition: Condition | null = null;
  flips: Flip[] = [];
  /** Recent client-reported end-to-end latencies, newest last. */
  latencies: number[] = [];
  /** Recent trend samples, index points per minute. */
  trends: number[] = [];
  sourceSignature: string | null = null;
  calibrationSignature: string | null = null;
  everHadReading = false;
  laneState: string | null = null;
  laneConfidence = 0;
  /** When the lane was last reported lost, so a momentary loss is not an incident. */
  laneLostSince = 0;
  readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }
}

const LATENCY_WINDOW = 120;
const TREND_WINDOW = 20;

export class Monitor {
  private states = new Map<string, SessionState>();
  private timer: NodeJS.Timeout | null = null;
  private readonly th: MonitorThresholds;
  private readonly store: Store;
  private readonly bus: Bus;
  private readonly metrics: Metrics;
  private readonly config: Config;
  private readonly log: Logger;

  constructor(store: Store, bus: Bus, metrics: Metrics, config: Config, log: Logger) {
    this.store = store;
    this.bus = bus;
    this.metrics = metrics;
    this.config = config;
    this.log = log;
    this.th = config.monitor;
  }

  start() {
    if (this.timer) return;
    // Adopt sessions that were active when the process last stopped, so a
    // restart mid-session does not silently stop watching them.
    for (const s of this.store.activeSessions()) this.state(s.id).calibrationSignature = s.source_signature;
    this.timer = setInterval(() => this.sweep(), this.config.monitorTickMs);
    this.timer.unref?.();
    this.log.info('monitor started', { tickMs: this.config.monitorTickMs, thresholds: this.th });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private state(sessionId: string): SessionState {
    let s = this.states.get(sessionId);
    if (!s) {
      s = new SessionState(sessionId);
      this.states.set(sessionId, s);
    }
    return s;
  }

  forget(sessionId: string) {
    this.states.delete(sessionId);
  }

  // ── Fed by ingest ────────────────────────────────────────────────────

  /**
   * Observe a batch of readings as they arrive.
   *
   * Condition flips are counted here rather than on the sweep because the
   * client posts at ~1 Hz after downsampling and a flip that happens between
   * two sweeps would otherwise be invisible.
   */
  observeReadings(
    sessionId: string,
    rows: { t: number; condition: Condition; trend: number; latencyMs?: number }[],
    sourceSignature?: string,
    lane?: { state: string; confidence: number },
  ) {
    if (rows.length === 0) return;
    const s = this.state(sessionId);
    s.lastReadingAt = Date.now();
    s.everHadReading = true;
    if (sourceSignature) s.sourceSignature = sourceSignature;

    if (lane) {
      s.laneState = lane.state;
      s.laneConfidence = lane.confidence;
      const bad = lane.state === 'lost' || lane.state === 'searching';
      if (bad && s.laneLostSince === 0) s.laneLostSince = Date.now();
      if (!bad) s.laneLostSince = 0;
    }

    for (const r of rows) {
      if (r.t > s.lastReadingT) s.lastReadingT = r.t;

      if (s.lastCondition && r.condition !== s.lastCondition) {
        s.flips.push({ at: r.t, from: s.lastCondition, to: r.condition });
      }
      s.lastCondition = r.condition;

      if (typeof r.latencyMs === 'number' && Number.isFinite(r.latencyMs)) {
        s.latencies.push(r.latencyMs);
        if (s.latencies.length > LATENCY_WINDOW) s.latencies.shift();
      }
      if (Number.isFinite(r.trend)) {
        s.trends.push(r.trend);
        if (s.trends.length > TREND_WINDOW) s.trends.shift();
      }
    }

    const cutoff = Date.now() - this.th.instabilityWindowMs;
    while (s.flips.length && s.flips[0].at < cutoff) s.flips.shift();
  }

  observeCalibration(sessionId: string, signature: string | null) {
    this.state(sessionId).calibrationSignature = signature;
  }

  /** Called after each verification so drift is evaluated promptly, not on a timer. */
  observeVerification(sessionId: string) {
    this.checkVerification(sessionId);
  }

  // ── The sweep ────────────────────────────────────────────────────────

  private sweep() {
    const now = Date.now();
    let active = 0;
    let openIncidents = 0;

    try {
      for (const session of this.store.activeSessions()) {
        active++;

        if (now - session.last_seen_at > this.config.sessionIdleMs) {
          this.abandon(session, now);
          continue;
        }

        this.checkStall(session, now);
        this.checkLatency(session);
        this.checkInstability(session);
        this.checkSurge(session);
        this.checkCalibration(session);
        this.checkLane(session, now);
        this.checkVerification(session.id);
      }
      openIncidents = this.store.allOpenIncidents().length;
    } catch (err) {
      // A monitor that dies takes the watchdog with it and nothing says so.
      this.log.error('monitor sweep failed', { err });
      this.metrics.inc('pitvision_monitor_sweep_errors_total');
    }

    this.metrics.set('pitvision_active_sessions', active);
    this.metrics.set('pitvision_open_incidents', openIncidents);
    this.metrics.set('pitvision_sse_subscribers', this.bus.subscriberCount);
    this.metrics.inc('pitvision_monitor_sweeps_total');
  }

  private abandon(session: SessionRow, now: number) {
    this.store.endSession(session.id, 'idle timeout', 'abandoned', now);
    this.store.closeAllIncidents(session.id, now);
    this.forget(session.id);
    this.log.info('session abandoned', {
      sessionId: session.id,
      idleMs: now - session.last_seen_at,
    });
    this.bus.publish({ type: 'session.ended', sessionId: session.id, data: { reason: 'idle timeout', status: 'abandoned' } });
  }

  // ── Individual checks ────────────────────────────────────────────────

  /**
   * A live feed that stops producing readings.
   *
   * Only armed once a session has produced at least one reading — a session
   * created the instant footage is dropped has not stalled, it has not started,
   * and raising an incident for that trains people to ignore this one.
   */
  private checkStall(session: SessionRow, now: number) {
    const s = this.state(session.id);
    if (!s.everHadReading) return;

    const gap = now - s.lastReadingAt;
    if (gap > this.th.stallMs) {
      this.open(session.id, 'feed_stall', 'critical', 'Feed stalled', {
        detail:
          `No readings for ${(gap / 1000).toFixed(1)}s (limit ${(this.th.stallMs / 1000).toFixed(1)}s). ` +
          `The readout on screen is frozen at its last value, which is indistinguishable from stable weather.`,
        payload: { gapMs: gap, lastReadingT: s.lastReadingT },
      });
    } else {
      this.close(session.id, 'feed_stall');
    }
  }

  private checkLatency(session: SessionRow) {
    const s = this.state(session.id);
    if (s.latencies.length < 20) return;

    const budget = this.th.latencyBudgetMs;
    const breaches = s.latencies.filter((v) => v > budget).length;
    const ratio = breaches / s.latencies.length;
    const sorted = [...s.latencies].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];

    if (ratio > this.th.latencyBreachRatio) {
      this.open(session.id, 'latency_budget', 'warn', 'Latency budget breached', {
        detail:
          `p95 end-to-end ${p95.toFixed(0)}ms against a ${budget}ms budget; ` +
          `${(ratio * 100).toFixed(0)}% of the last ${s.latencies.length} frames were over. ` +
          `The displayed condition is lagging the track.`,
        payload: { p95, ratio, samples: s.latencies.length, budget },
      });
    } else {
      this.close(session.id, 'latency_budget');
    }
  }

  /**
   * The classifier changing its mind repeatedly.
   *
   * Hysteresis and the hold counter exist to prevent this, so hitting the
   * threshold means those are mistuned for this footage or the anchors are
   * wrong — and the visible symptom is a strategist being given contradictory
   * tyre calls a few seconds apart.
   */
  private checkInstability(session: SessionRow) {
    const s = this.state(session.id);
    const cutoff = Date.now() - this.th.instabilityWindowMs;
    while (s.flips.length && s.flips[0].at < cutoff) s.flips.shift();

    if (s.flips.length >= this.th.instabilityFlips) {
      const seq = s.flips.map((f) => f.to).join(' → ');
      this.open(session.id, 'condition_instability', 'warn', 'Condition label unstable', {
        detail:
          `${s.flips.length} condition changes in ${(this.th.instabilityWindowMs / 1000).toFixed(0)}s: ${seq}. ` +
          `Hysteresis and the hold counter are not holding — the calibration anchors are likely wrong for this footage.`,
        payload: { flips: s.flips.length, sequence: seq },
      });
    } else {
      this.close(session.id, 'condition_instability');
    }
  }

  /**
   * Weather, not infrastructure — but it belongs on the same wall.
   *
   * Raised on a *sustained* trend rather than a single sample, because the
   * least-squares slope spikes hard for one tick whenever anything moves.
   */
  private checkSurge(session: SessionRow) {
    const s = this.state(session.id);
    if (s.trends.length < 5) return;
    const recent = s.trends.slice(-5);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;

    if (mean > this.th.surgePerMin) {
      this.open(session.id, 'rapid_wetting', 'critical', 'Rapid wetting', {
        detail:
          `Wetness index climbing ${mean.toFixed(1)} points/min, sustained over ${recent.length} samples. ` +
          `Compound change territory.`,
        payload: { perMin: Number(mean.toFixed(2)) },
      });
    } else if (mean < this.th.surgePerMin * 0.5) {
      // Asymmetric close, so a trend hovering on the threshold does not
      // open and close the same incident every couple of seconds.
      this.close(session.id, 'rapid_wetting');
    }
  }

  /**
   * Anchors from a different feed.
   *
   * The client already shows a banner for this, but the banner is advisory and
   * the readings are recorded regardless. Recording that a stretch of a session
   * ran on foreign anchors is what makes those numbers interpretable later,
   * instead of quietly wrong.
   */
  /**
   * The detector has lost the road.
   *
   * This is the most consequential of these checks and the least obvious from
   * the readout. Every other failure mode either stops the numbers or makes
   * them visibly wrong; this one keeps them flowing, correctly computed, over a
   * region that is no longer the track — a corridor left over from before the
   * camera cut away, or one that never locked on at all. The index stays in
   * range, the trend stays smooth, and it is describing a pit wall.
   *
   * Held for a few seconds first: a car crossing the frame or a burst of spray
   * loses the trace briefly and the client already carries the last corridor
   * through that, which is the correct behaviour and not worth an alarm.
   */
  private checkLane(session: SessionRow, now: number) {
    const s = this.state(session.id);
    if (s.laneState === null || s.laneState === 'manual') {
      this.close(session.id, 'lane_lost');
      return;
    }

    const lostFor = s.laneLostSince === 0 ? 0 : now - s.laneLostSince;
    if (lostFor > this.th.laneLostMs) {
      this.open(session.id, 'lane_lost', 'critical', 'Road not being traced', {
        detail:
          `The lane tracer has been ${s.laneState} for ${(lostFor / 1000).toFixed(1)}s. ` +
          `Readings are still arriving, but they are measured through the last known region — ` +
          `which may no longer be track. Check the overlay before acting on the index.`,
        payload: { state: s.laneState, confidence: s.laneConfidence, lostForMs: lostFor },
      });
    } else {
      this.close(session.id, 'lane_lost');
    }
  }

  private checkCalibration(session: SessionRow) {
    const s = this.state(session.id);
    if (!s.sourceSignature || !s.calibrationSignature) return;

    if (s.sourceSignature !== s.calibrationSignature) {
      this.open(session.id, 'calibration_mismatch', 'warn', 'Calibration is not from this feed', {
        detail:
          `Readings are being scored against anchors measured on a different source. ` +
          `The wetness index is not comparable with this footage until the pre-race check is re-run.`,
        payload: { feed: s.sourceSignature, calibration: s.calibrationSignature },
      });
    } else {
      this.close(session.id, 'calibration_mismatch');
    }
  }

  /**
   * Agreement between the detector and the second opinion.
   *
   * The README's claim is that disagreement is surfaced rather than hidden. It
   * was surfaced one frame at a time, in a card that the next verification
   * overwrote ten seconds later — so a detector that had drifted and was being
   * contradicted every single time looked identical to one that was contradicted
   * once. This is the check that makes the claim true across a session.
   *
   * A neighbouring band counts as half agreement: Damp against Wet is a
   * judgement call between two people looking at the same tarmac, Dry against
   * Flooded is a broken detector, and scoring them the same way would bury the
   * signal that matters.
   */
  private checkVerification(sessionId: string) {
    const streak = this.store.verifyFailureStreak(sessionId);
    if (streak >= this.th.verifyFailStreak) {
      this.open(sessionId, 'verification_down', 'warn', 'AI verification failing', {
        detail:
          `${streak} consecutive verification calls failed. The second opinion is unavailable — ` +
          `the CV readout is unaffected, but nothing is checking it.`,
        payload: { streak },
      });
    } else if (streak === 0) {
      this.close(sessionId, 'verification_down');
    }

    const grades = this.store.recentGrades(sessionId, 12);
    if (grades.length < this.th.driftMinSamples) return;

    const score = grades.reduce((a, g) => a + agreementScore(g), 0) / grades.length;
    const conflicts = grades.filter((g) => g === 'conflict').length;

    if (score < this.th.driftFloor) {
      this.open(sessionId, 'verification_drift', 'critical', 'CV and AI disagree persistently', {
        detail:
          `Agreement ${(score * 100).toFixed(0)}% over the last ${grades.length} verifications ` +
          `(${conflicts} outright conflicts). The index is probably being scored against the wrong ` +
          `anchors — re-run the pre-race check before trusting a tyre call from it.`,
        payload: { score: Number(score.toFixed(3)), samples: grades.length, conflicts },
      });
    } else {
      this.close(sessionId, 'verification_drift');
    }
  }

  // ── Incident lifecycle ───────────────────────────────────────────────

  private open(
    sessionId: string,
    kind: IncidentKind,
    severity: 'warn' | 'critical',
    summary: string,
    extra: { detail: string; payload?: unknown },
  ) {
    const incident = this.store.openIncident({
      sessionId,
      kind,
      severity,
      summary,
      detail: extra.detail,
      payload: extra.payload ? JSON.stringify(extra.payload) : null,
    });
    if (!incident) return; // already open — do not re-alert

    this.store.insertEvents(sessionId, [
      {
        origin: 'monitor',
        kind,
        level: severity === 'critical' ? 'critical' : 'warn',
        title: summary,
        detail: extra.detail,
        payload: extra.payload ? JSON.stringify(extra.payload) : null,
      },
    ]);

    this.metrics.inc('pitvision_incidents_opened_total', 1, { kind });
    this.log.warn('incident opened', { sessionId, kind, severity, summary });
    this.bus.publish({ type: 'incident.opened', sessionId, data: incident });
  }

  private close(sessionId: string, kind: IncidentKind) {
    const closed = this.store.closeIncident(sessionId, kind);
    if (!closed) return;

    const heldMs = (closed.closed_at ?? Date.now()) - closed.opened_at;
    this.store.insertEvents(sessionId, [
      {
        origin: 'monitor',
        kind,
        level: 'info',
        title: `Cleared: ${closed.summary}`,
        detail: `Held for ${(heldMs / 1000).toFixed(1)}s.`,
      },
    ]);

    this.metrics.inc('pitvision_incidents_closed_total', 1, { kind });
    this.log.info('incident closed', { sessionId, kind, heldMs });
    this.bus.publish({ type: 'incident.closed', sessionId, data: closed });
  }
}
