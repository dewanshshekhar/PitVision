/**
 * Session reports.
 *
 * The live readout answers "what is the track doing now". This answers the
 * questions that get asked afterwards, in a debrief, when nobody can replay the
 * session: how long were we in each condition, when did the dry line form, was
 * the detector trustworthy, did we make the latency budget, and what did the
 * verification cost.
 *
 * Everything here is computed from the stored series. Nothing is a model's
 * opinion — the numbers either come out of the readings or they are not
 * reported.
 */

import type { Store, SessionRow, ReadingRow } from './store.ts';
import type { Config } from '../config.ts';
import { agreementScore, type Condition } from '../domain/conditions.ts';

export interface Segment {
  condition: Condition;
  from: number;
  to: number;
  durationMs: number;
  samples: number;
  peakWetness: number;
  meanWetness: number;
}

export interface SessionReport {
  session: {
    id: string;
    status: string;
    startedAt: number | null;
    endedAt: number | null;
    durationMs: number;
    source: { kind: string; label: string | null; signature: string | null };
    entrant: {
      driver: string | null;
      number: string | null;
      team: string | null;
      car: string | null;
      circuit: string | null;
      session: string | null;
    };
    baselineLapS: number | null;
  };
  coverage: {
    readings: number;
    /**
     * The span the readings actually cover: last timestamp minus first.
     *
     * This is not the same as `session.durationMs`, and conflating them
     * produced a report that contradicted itself. `session.durationMs` is how
     * long the session *record* was open — wall clock. The readings carry the
     * timestamps of the footage being analysed, and on a loaded clip those two
     * clocks are unrelated: a 22-minute clip scanned in seconds gave a headline
     * reading "0.1 min session, 1320 readings", which is 220 Hz and impossible.
     *
     * Everything about the *track* is measured against this span. Everything
     * about the *session* stays on wall clock.
     */
    spanMs: number;
    expectedAtOneHz: number;
    /** Fraction of the span actually covered by readings. Gaps show here. */
    ratio: number;
    largestGapMs: number;
    firstReadingAt: number | null;
    lastReadingAt: number | null;
  };
  wetness: {
    min: number;
    max: number;
    mean: number;
    p95: number;
    peakAt: number | null;
    /** Steepest sustained climb and fall observed, index points per minute. */
    fastestRisePerMin: number;
    fastestFallPerMin: number;
  };
  conditions: {
    timeline: Segment[];
    timeIn: Record<string, { ms: number; pct: number; samples: number }>;
    changes: number;
    dominant: Condition | null;
  };
  crossovers: {
    /** Windows where the classifier committed to `Drying` — the dry line. */
    dryingWindows: { from: number; to: number; durationMs: number; peakDivergence: number }[];
    maxDivergence: number;
    maxDivergenceAt: number | null;
  };
  latency: {
    samples: number;
    mean: number;
    p50: number;
    p95: number;
    max: number;
    budgetMs: number;
    overBudgetPct: number;
  };
  verification: {
    attempts: number;
    ok: number;
    failed: number;
    comparable: number;
    /** Weighted agreement: exact match 1.0, neighbouring band 0.5. */
    agreementRate: number | null;
    matches: number;
    adjacent: number;
    conflicts: number;
    unknown: number;
    meanConfidence: number | null;
    meanLatencyMs: number | null;
    disagreements: {
      t: number;
      cv: string | null;
      ai: string | null;
      confidence: number | null;
      reasoning: string | null;
    }[];
    cost: { inputTokens: number; outputTokens: number; usd: number };
  };
  monitoring: {
    incidents: {
      kind: string;
      severity: string;
      openedAt: number;
      closedAt: number | null;
      durationMs: number;
      summary: string;
      detail: string | null;
    }[];
    openNow: number;
    /** Fraction of the session with no open incident of any kind. */
    cleanRatio: number;
  };
  events: { total: number; byKind: Record<string, number>; byLevel: Record<string, number> };
  calibration: {
    runs: number;
    latest: { at: number; ok: boolean; verdict: string | null; anchoring: string | null; divergenceReliable: boolean | null } | null;
  };
  /** Plain-language read of the numbers above. Rules, not a model. */
  headline: string[];
}

export function buildReport(store: Store, session: SessionRow, config: Config): SessionReport {
  const readings = store.readings(session.id, { limit: 200_000 });
  const verifications = store.verifications(session.id, 5000);
  const incidents = store.incidents(session.id, { limit: 500 });
  const events = store.events(session.id, 5000);
  const calibrations = store.calibrations(session.id, 50) as Record<string, unknown>[];

  const start = session.started_at ?? session.created_at;
  const end = session.ended_at ?? session.last_seen_at;
  const durationMs = Math.max(0, end - start);

  const coverage = computeCoverage(readings, durationMs);
  const wetness = computeWetness(readings);
  const conditions = computeConditions(readings, durationMs);
  const crossovers = computeCrossovers(readings);
  const latency = computeLatency(readings, config.monitor.latencyBudgetMs);
  const verification = computeVerification(verifications);
  const monitoring = computeMonitoring(incidents, start, end);
  const eventStats = computeEvents(events);

  const report: SessionReport = {
    session: {
      id: session.id,
      status: session.status,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      durationMs,
      source: {
        kind: session.source_kind,
        label: session.source_label,
        signature: session.source_signature,
      },
      entrant: {
        driver: session.driver,
        number: session.car_number,
        team: session.team,
        car: session.car,
        circuit: session.circuit,
        session: session.session_name,
      },
      baselineLapS: session.baseline_lap_s,
    },
    coverage,
    wetness,
    conditions,
    crossovers,
    latency,
    verification,
    monitoring,
    events: eventStats,
    calibration: {
      runs: calibrations.length,
      latest: calibrations[0]
        ? {
            at: Number(calibrations[0].t),
            ok: Number(calibrations[0].ok) === 1,
            verdict: (calibrations[0].verdict as string) ?? null,
            anchoring: (calibrations[0].anchoring as string) ?? null,
            divergenceReliable:
              calibrations[0].divergence_reliable === null
                ? null
                : Number(calibrations[0].divergence_reliable) === 1,
          }
        : null,
    },
    headline: [],
  };

  report.headline = headline(report);
  return report;
}

// ── Sections ───────────────────────────────────────────────────────────

function computeCoverage(readings: ReadingRow[], durationMs: number): SessionReport['coverage'] {
  if (readings.length === 0) {
    return {
      readings: 0,
      spanMs: 0,
      expectedAtOneHz: 0,
      ratio: 0,
      largestGapMs: durationMs,
      firstReadingAt: null,
      lastReadingAt: null,
    };
  }
  let largestGap = 0;
  for (let i = 1; i < readings.length; i++) {
    largestGap = Math.max(largestGap, readings[i].t - readings[i - 1].t);
  }
  const first = readings[0].t;
  const last = readings[readings.length - 1].t;
  const spanMs = Math.max(0, last - first);
  // Coverage is measured against the span the readings themselves cover, not
  // against how long the session record was open. Against wall clock, a clip
  // analysed faster than real time reports impossible coverage, and one
  // analysed slower reports a gap that is not there.
  const expected = Math.max(1, Math.round(spanMs / 1000));
  return {
    readings: readings.length,
    spanMs,
    expectedAtOneHz: expected,
    ratio: Math.min(1, readings.length / expected),
    largestGapMs: largestGap,
    firstReadingAt: first,
    lastReadingAt: last,
  };
}

function computeWetness(readings: ReadingRow[]): SessionReport['wetness'] {
  if (readings.length === 0) {
    return { min: 0, max: 0, mean: 0, p95: 0, peakAt: null, fastestRisePerMin: 0, fastestFallPerMin: 0 };
  }
  const values = readings.map((r) => r.wetness);
  const sorted = [...values].sort((a, b) => a - b);
  let peak = readings[0];
  for (const r of readings) if (r.wetness > peak.wetness) peak = r;

  // The stored `trend` is the engine's own least-squares slope, which already
  // has the right window on it. Recomputing a slope from a downsampled series
  // here would produce a different and less trustworthy number.
  let rise = 0;
  let fall = 0;
  for (const r of readings) {
    if (r.trend > rise) rise = r.trend;
    if (r.trend < fall) fall = r.trend;
  }

  return {
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    mean: round(values.reduce((a, b) => a + b, 0) / values.length),
    p95: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]),
    peakAt: peak.t,
    fastestRisePerMin: round(rise),
    fastestFallPerMin: round(fall),
  };
}

function computeConditions(readings: ReadingRow[], durationMs: number): SessionReport['conditions'] {
  const timeline: Segment[] = [];
  const timeIn: Record<string, { ms: number; pct: number; samples: number }> = {};

  for (const r of readings) {
    const last = timeline[timeline.length - 1];
    if (last && last.condition === r.condition) {
      last.to = r.t;
      last.durationMs = last.to - last.from;
      last.samples++;
      last.peakWetness = Math.max(last.peakWetness, r.wetness);
      last.meanWetness += (r.wetness - last.meanWetness) / last.samples;
    } else {
      timeline.push({
        condition: r.condition,
        from: r.t,
        to: r.t,
        durationMs: 0,
        samples: 1,
        peakWetness: r.wetness,
        meanWetness: r.wetness,
      });
    }
  }

  for (const seg of timeline) {
    seg.peakWetness = round(seg.peakWetness);
    seg.meanWetness = round(seg.meanWetness);
    const acc = (timeIn[seg.condition] ??= { ms: 0, pct: 0, samples: 0 });
    acc.ms += seg.durationMs;
    acc.samples += seg.samples;
  }

  const total = Object.values(timeIn).reduce((a, b) => a + b.ms, 0) || durationMs || 1;
  for (const acc of Object.values(timeIn)) acc.pct = round((acc.ms / total) * 100);

  let dominant: Condition | null = null;
  let best = -1;
  for (const [cond, acc] of Object.entries(timeIn)) {
    if (acc.ms > best) {
      best = acc.ms;
      dominant = cond as Condition;
    }
  }

  return { timeline, timeIn, changes: Math.max(0, timeline.length - 1), dominant };
}

function computeCrossovers(readings: ReadingRow[]): SessionReport['crossovers'] {
  const windows: SessionReport['crossovers']['dryingWindows'] = [];
  let maxDiv = -Infinity;
  let maxDivAt: number | null = null;
  let open: (typeof windows)[number] | null = null;

  for (const r of readings) {
    if (r.divergence > maxDiv) {
      maxDiv = r.divergence;
      maxDivAt = r.t;
    }
    if (r.condition === 'Drying') {
      if (!open) {
        open = { from: r.t, to: r.t, durationMs: 0, peakDivergence: r.divergence };
        windows.push(open);
      } else {
        open.to = r.t;
        open.durationMs = open.to - open.from;
        open.peakDivergence = Math.max(open.peakDivergence, r.divergence);
      }
    } else {
      open = null;
    }
  }

  for (const w of windows) w.peakDivergence = round(w.peakDivergence);
  return {
    dryingWindows: windows,
    maxDivergence: readings.length ? round(maxDiv) : 0,
    maxDivergenceAt: maxDivAt,
  };
}

function computeLatency(readings: ReadingRow[], budgetMs: number): SessionReport['latency'] {
  const values = readings
    .map((r) => r.latency_ms)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

  if (values.length === 0) {
    return { samples: 0, mean: 0, p50: 0, p95: 0, max: 0, budgetMs, overBudgetPct: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const over = values.filter((v) => v > budgetMs).length;
  return {
    samples: values.length,
    mean: round(values.reduce((a, b) => a + b, 0) / values.length),
    p50: round(sorted[Math.floor(sorted.length * 0.5)]),
    p95: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]),
    max: round(sorted[sorted.length - 1]),
    budgetMs,
    overBudgetPct: round((over / values.length) * 100),
  };
}

function computeVerification(rows: ReturnType<Store['verifications']>): SessionReport['verification'] {
  const ok = rows.filter((r) => r.status === 'ok');
  const graded = ok.filter((r) => r.agreement && r.agreement !== 'unknown');

  const matches = ok.filter((r) => r.agreement === 'match').length;
  const adjacent = ok.filter((r) => r.agreement === 'adjacent').length;
  const conflicts = ok.filter((r) => r.agreement === 'conflict').length;
  const unknown = ok.filter((r) => r.agreement === 'unknown').length;

  const confidences = ok
    .map((r) => r.confidence)
    .filter((v): v is number => typeof v === 'number');
  const latencies = ok.map((r) => r.latency_ms).filter((v): v is number => typeof v === 'number');

  const inputTokens = rows.reduce((a, r) => a + (r.input_tokens ?? 0), 0);
  const outputTokens = rows.reduce((a, r) => a + (r.output_tokens ?? 0), 0);
  const usd = rows.reduce((a, r) => a + (r.cost_usd ?? 0), 0);

  return {
    attempts: rows.length,
    ok: ok.length,
    failed: rows.length - ok.length,
    comparable: graded.length,
    agreementRate:
      graded.length === 0
        ? null
        : round(
            (graded.reduce((a, r) => a + agreementScore(r.agreement!), 0) / graded.length) * 100,
          ),
    matches,
    adjacent,
    conflicts,
    unknown,
    meanConfidence: confidences.length
      ? round(confidences.reduce((a, b) => a + b, 0) / confidences.length, 3)
      : null,
    meanLatencyMs: latencies.length
      ? round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null,
    // The whole point of recording verifications is being able to look these up
    // afterwards, so the conflicts are carried in the report rather than left
    // behind a second query.
    disagreements: ok
      .filter((r) => r.agreement === 'conflict')
      .slice(0, 25)
      .map((r) => ({
        t: r.t,
        cv: r.cv_condition,
        ai: r.ai_condition,
        confidence: r.confidence,
        reasoning: r.reasoning,
      })),
    cost: { inputTokens, outputTokens, usd: round(usd, 4) },
  };
}

function computeMonitoring(
  incidents: ReturnType<Store['incidents']>,
  start: number,
  end: number,
): SessionReport['monitoring'] {
  const mapped = incidents.map((i) => ({
    kind: i.kind,
    severity: i.severity,
    openedAt: i.opened_at,
    closedAt: i.closed_at,
    durationMs: (i.closed_at ?? end) - i.opened_at,
    summary: i.summary,
    detail: i.detail,
  }));

  // Union of the open intervals, so overlapping incidents are not double
  // counted when working out how much of the session was actually clean.
  const spans = mapped
    .map((i) => [Math.max(start, i.openedAt), Math.min(end, i.closedAt ?? end)] as const)
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);

  let covered = 0;
  let cursor = -Infinity;
  for (const [from, to] of spans) {
    const s = Math.max(from, cursor);
    if (to > s) {
      covered += to - s;
      cursor = to;
    }
  }

  const total = Math.max(1, end - start);
  return {
    incidents: mapped,
    openNow: mapped.filter((i) => i.closedAt === null).length,
    cleanRatio: round(Math.max(0, 1 - covered / total), 3),
  };
}

function computeEvents(events: ReturnType<Store['events']>): SessionReport['events'] {
  const byKind: Record<string, number> = {};
  const byLevel: Record<string, number> = {};
  for (const e of events) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    byLevel[e.level] = (byLevel[e.level] ?? 0) + 1;
  }
  return { total: events.length, byKind, byLevel };
}

/**
 * The debrief in sentences.
 *
 * Rule-based on purpose: the same numbers have to produce the same summary
 * every time, and a caveat about a detector that could not be trusted is the
 * last thing that should be phrased differently on each read.
 */
function headline(r: SessionReport): string[] {
  const lines: string[] = [];

  if (r.coverage.readings === 0) {
    return ['Session recorded no readings — the feed never produced an analysed frame.'];
  }

  // Footage analysed, not wall clock. On a loaded clip the two differ, and the
  // sentence is about what the track did.
  const mins = (r.coverage.spanMs / 60000).toFixed(1);
  lines.push(
    `${mins} min of footage analysed, ${r.coverage.readings} readings, ` +
      `${r.conditions.dominant ?? 'unknown'} for ${r.conditions.timeIn[r.conditions.dominant ?? '']?.pct ?? 0}% of it.`,
  );
  lines.push(
    `Wetness index ranged ${r.wetness.min}–${r.wetness.max} (mean ${r.wetness.mean}), ` +
      `across ${r.conditions.changes} condition changes.`,
  );

  if (r.crossovers.dryingWindows.length > 0) {
    const longest = r.crossovers.dryingWindows.reduce((a, b) => (b.durationMs > a.durationMs ? b : a));
    lines.push(
      `A dry line was called ${r.crossovers.dryingWindows.length} time(s); the longest held ` +
        `${(longest.durationMs / 1000).toFixed(0)}s at up to ${longest.peakDivergence} points of divergence.`,
    );
  }

  if (r.latency.samples > 0) {
    lines.push(
      r.latency.overBudgetPct > 5
        ? `Latency missed budget: p95 ${r.latency.p95}ms against ${r.latency.budgetMs}ms, ${r.latency.overBudgetPct}% of frames over.`
        : `Latency held: p95 ${r.latency.p95}ms against a ${r.latency.budgetMs}ms budget.`,
    );
  }

  if (r.verification.comparable === 0) {
    lines.push(
      r.verification.attempts === 0
        ? 'No AI verification ran — the detector was unchecked for this session.'
        : `AI verification ran ${r.verification.attempts} time(s) but produced no comparable verdict.`,
    );
  } else {
    lines.push(
      `AI agreed with the detector ${r.verification.agreementRate}% of the time over ` +
        `${r.verification.comparable} comparable checks (${r.verification.conflicts} outright conflicts).`,
    );
  }

  if (r.verification.cost.usd > 0) {
    lines.push(`Verification cost $${r.verification.cost.usd.toFixed(4)} across ${r.verification.attempts} calls.`);
  }

  if (r.monitoring.incidents.length === 0) {
    lines.push('No monitoring incidents — the pipeline ran clean throughout.');
  } else {
    const worst = r.monitoring.incidents.filter((i) => i.severity === 'critical').length;
    lines.push(
      `${r.monitoring.incidents.length} incident(s) raised (${worst} critical); ` +
        `${(r.monitoring.cleanRatio * 100).toFixed(0)}% of the session was clean.`,
    );
  }

  // The caveat goes last so it is the thing left on screen.
  if (r.verification.agreementRate !== null && r.verification.agreementRate < 50) {
    lines.push(
      'Treat this session as unverified: the detector and the vision model disagreed more often ' +
        'than they agreed, which usually means the calibration anchors did not match the footage.',
    );
  }

  return lines;
}

function round(v: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
