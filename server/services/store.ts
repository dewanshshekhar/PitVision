/**
 * Everything that reads or writes the telemetry tables.
 *
 * Kept as one module because the tables are joined constantly and splitting
 * them per-table would mean a repository layer whose only job is to be
 * assembled again one level up.
 */

import type { Db } from '../db/index.ts';
import type { Condition, AgreementLevel } from '../domain/conditions.ts';
import { newSessionId } from '../lib/ids.ts';

export type SessionStatus = 'active' | 'ended' | 'abandoned';

export interface SessionRow {
  id: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  last_seen_at: number;
  status: SessionStatus;
  end_reason: string | null;
  source_kind: string;
  source_label: string | null;
  source_signature: string | null;
  driver: string | null;
  car_number: string | null;
  team: string | null;
  car: string | null;
  circuit: string | null;
  session_name: string | null;
  baseline_lap_s: number | null;
  client_id: string | null;
  user_agent: string | null;
  app_version: string | null;
  notes: string | null;
}

export interface NewSession {
  sourceKind: string;
  sourceLabel?: string;
  sourceSignature?: string;
  driver?: string;
  carNumber?: string;
  team?: string;
  car?: string;
  circuit?: string;
  sessionName?: string;
  baselineLapS?: number;
  clientId?: string;
  userAgent?: string;
  appVersion?: string;
}

export interface ReadingInput {
  t: number;
  wetness: number;
  wetnessRaw: number;
  line: number;
  edge: number;
  divergence: number;
  condition: Condition;
  trend: number;
  signals?: { glare: number; texture: number; darkness: number; specular: number };
  normalised?: { glare: number; texture: number; darkness: number; specular: number };
  analysisMs?: number;
  latencyMs?: number;
}

export interface ReadingRow {
  session_id: string;
  t: number;
  wetness: number;
  wetness_raw: number;
  line: number;
  edge: number;
  divergence: number;
  condition: Condition;
  trend: number;
  sig_glare: number | null;
  sig_texture: number | null;
  sig_darkness: number | null;
  sig_specular: number | null;
  nrm_glare: number | null;
  nrm_texture: number | null;
  nrm_darkness: number | null;
  nrm_specular: number | null;
  analysis_ms: number | null;
  latency_ms: number | null;
}

export interface EventInput {
  t?: number;
  origin: 'client' | 'monitor';
  kind: string;
  level: 'info' | 'warn' | 'critical';
  title: string;
  detail?: string;
  payload?: string | null;
}

export interface EventRow {
  id: number;
  session_id: string;
  t: number;
  origin: 'client' | 'monitor';
  kind: string;
  level: 'info' | 'warn' | 'critical';
  title: string;
  detail: string | null;
  payload: string | null;
}

export interface VerificationInput {
  sessionId: string | null;
  t: number;
  status: 'ok' | 'refused' | 'error' | 'timeout';
  cvCondition?: Condition | null;
  cvWetness?: number | null;
  cvLine?: number | null;
  cvEdge?: number | null;
  cvTrend?: number | null;
  aiCondition?: string | null;
  confidence?: number | null;
  reasoning?: string | null;
  agreement?: AgreementLevel | null;
  model?: string | null;
  latencyMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  imageBytes?: number | null;
  attempts?: number | null;
  error?: string | null;
}

export interface VerificationRow {
  id: number;
  session_id: string | null;
  t: number;
  status: string;
  cv_condition: Condition | null;
  cv_wetness: number | null;
  ai_condition: string | null;
  confidence: number | null;
  reasoning: string | null;
  agreement: AgreementLevel | null;
  model: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  error: string | null;
}

export interface IncidentRow {
  id: number;
  session_id: string;
  kind: string;
  severity: 'warn' | 'critical';
  opened_at: number;
  closed_at: number | null;
  summary: string;
  detail: string | null;
  payload: string | null;
}

export class Store {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // ── Sessions ─────────────────────────────────────────────────────────

  createSession(input: NewSession, now = Date.now()): SessionRow {
    const id = newSessionId();
    this.db.run(
      `INSERT INTO sessions (
         id, created_at, started_at, last_seen_at, status,
         source_kind, source_label, source_signature,
         driver, car_number, team, car, circuit, session_name, baseline_lap_s,
         client_id, user_agent, app_version
       ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      now,
      now,
      now,
      input.sourceKind,
      input.sourceLabel ?? null,
      input.sourceSignature ?? null,
      input.driver ?? null,
      input.carNumber ?? null,
      input.team ?? null,
      input.car ?? null,
      input.circuit ?? null,
      input.sessionName ?? null,
      input.baselineLapS ?? null,
      input.clientId ?? null,
      input.userAgent ?? null,
      input.appVersion ?? null,
    );
    return this.getSession(id)!;
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', id);
  }

  listSessions(opts: { limit: number; offset: number; status?: SessionStatus }): SessionRow[] {
    if (opts.status) {
      return this.db.all<SessionRow>(
        'SELECT * FROM sessions WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
        opts.status,
        opts.limit,
        opts.offset,
      );
    }
    return this.db.all<SessionRow>(
      'SELECT * FROM sessions ORDER BY created_at DESC LIMIT ? OFFSET ?',
      opts.limit,
      opts.offset,
    );
  }

  countSessions(status?: SessionStatus): number {
    const row = status
      ? this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE status = ?', status)
      : this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions');
    return row?.n ?? 0;
  }

  activeSessions(): SessionRow[] {
    return this.db.all<SessionRow>("SELECT * FROM sessions WHERE status = 'active'");
  }

  touchSession(id: string, now = Date.now()) {
    this.db.run("UPDATE sessions SET last_seen_at = ? WHERE id = ? AND status = 'active'", now, id);
  }

  updateSession(id: string, patch: Partial<Record<string, string | number | null>>) {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const sql = `UPDATE sessions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
    this.db.run(sql, ...keys.map((k) => patch[k] ?? null), id);
  }

  endSession(id: string, reason: string, status: SessionStatus = 'ended', now = Date.now()) {
    this.db.run(
      "UPDATE sessions SET status = ?, ended_at = ?, end_reason = ? WHERE id = ? AND status = 'active'",
      status,
      now,
      reason,
      id,
    );
  }

  // ── Readings ─────────────────────────────────────────────────────────

  /**
   * Insert a batch in one transaction.
   *
   * `INSERT OR REPLACE` rather than plain insert because a client that retries
   * a batch after a network timeout must not fail the whole request on the rows
   * that already landed — at-least-once delivery is the only kind a browser on
   * a garage wifi can offer.
   */
  insertReadings(sessionId: string, rows: ReadingInput[]): number {
    if (rows.length === 0) return 0;
    return this.db.tx(() => {
      for (const r of rows) {
        this.db.run(
          `INSERT OR REPLACE INTO readings (
             session_id, t, wetness, wetness_raw, line, edge, divergence, condition, trend,
             sig_glare, sig_texture, sig_darkness, sig_specular,
             nrm_glare, nrm_texture, nrm_darkness, nrm_specular,
             analysis_ms, latency_ms
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          sessionId,
          r.t,
          r.wetness,
          r.wetnessRaw,
          r.line,
          r.edge,
          r.divergence,
          r.condition,
          r.trend,
          r.signals?.glare ?? null,
          r.signals?.texture ?? null,
          r.signals?.darkness ?? null,
          r.signals?.specular ?? null,
          r.normalised?.glare ?? null,
          r.normalised?.texture ?? null,
          r.normalised?.darkness ?? null,
          r.normalised?.specular ?? null,
          r.analysisMs ?? null,
          r.latencyMs ?? null,
        );
      }
      return rows.length;
    });
  }

  readings(sessionId: string, opts: { from?: number; to?: number; limit?: number } = {}): ReadingRow[] {
    return this.db.all<ReadingRow>(
      `SELECT * FROM readings
        WHERE session_id = ? AND t >= ? AND t <= ?
        ORDER BY t ASC LIMIT ?`,
      sessionId,
      opts.from ?? 0,
      opts.to ?? Number.MAX_SAFE_INTEGER,
      opts.limit ?? 20_000,
    );
  }

  latestReading(sessionId: string): ReadingRow | undefined {
    return this.db.get<ReadingRow>(
      'SELECT * FROM readings WHERE session_id = ? ORDER BY t DESC LIMIT 1',
      sessionId,
    );
  }

  countReadings(sessionId: string): number {
    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM readings WHERE session_id = ?',
      sessionId,
    );
    return row?.n ?? 0;
  }

  // ── Events ───────────────────────────────────────────────────────────

  insertEvents(sessionId: string, events: EventInput[], now = Date.now()): number {
    if (events.length === 0) return 0;
    return this.db.tx(() => {
      for (const e of events) {
        this.db.run(
          `INSERT INTO events (session_id, t, origin, kind, level, title, detail, payload)
           VALUES (?,?,?,?,?,?,?,?)`,
          sessionId,
          e.t ?? now,
          e.origin,
          e.kind,
          e.level,
          e.title,
          e.detail ?? null,
          e.payload ?? null,
        );
      }
      return events.length;
    });
  }

  events(sessionId: string, limit = 500): EventRow[] {
    return this.db.all<EventRow>(
      'SELECT * FROM events WHERE session_id = ? ORDER BY t DESC, id DESC LIMIT ?',
      sessionId,
      limit,
    );
  }

  // ── Verifications ────────────────────────────────────────────────────

  insertVerification(v: VerificationInput): number {
    const r = this.db.run(
      `INSERT INTO verifications (
         session_id, t, status, cv_condition, cv_wetness, cv_line, cv_edge, cv_trend,
         ai_condition, confidence, reasoning, agreement, model, latency_ms,
         input_tokens, output_tokens, cost_usd, image_bytes, attempts, error
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      v.sessionId,
      v.t,
      v.status,
      v.cvCondition ?? null,
      v.cvWetness ?? null,
      v.cvLine ?? null,
      v.cvEdge ?? null,
      v.cvTrend ?? null,
      v.aiCondition ?? null,
      v.confidence ?? null,
      v.reasoning ?? null,
      v.agreement ?? null,
      v.model ?? null,
      v.latencyMs ?? null,
      v.inputTokens ?? null,
      v.outputTokens ?? null,
      v.costUsd ?? null,
      v.imageBytes ?? null,
      v.attempts ?? null,
      v.error ?? null,
    );
    return r.lastInsertRowid;
  }

  verifications(sessionId: string, limit = 500): VerificationRow[] {
    return this.db.all<VerificationRow>(
      'SELECT * FROM verifications WHERE session_id = ? ORDER BY t DESC LIMIT ?',
      sessionId,
      limit,
    );
  }

  /** Most recent comparable verdicts, newest first — the drift window. */
  recentGrades(sessionId: string, limit: number): AgreementLevel[] {
    const rows = this.db.all<{ agreement: AgreementLevel }>(
      `SELECT agreement FROM verifications
        WHERE session_id = ? AND status = 'ok' AND agreement IS NOT NULL AND agreement != 'unknown'
        ORDER BY t DESC LIMIT ?`,
      sessionId,
      limit,
    );
    return rows.map((r) => r.agreement);
  }

  /** Consecutive failures at the head of the log — is the AI path down? */
  verifyFailureStreak(sessionId: string, lookback = 10): number {
    const rows = this.db.all<{ status: string }>(
      'SELECT status FROM verifications WHERE session_id = ? ORDER BY t DESC LIMIT ?',
      sessionId,
      lookback,
    );
    let n = 0;
    for (const r of rows) {
      if (r.status === 'ok' || r.status === 'refused') break;
      n++;
    }
    return n;
  }

  // ── Calibrations ─────────────────────────────────────────────────────

  insertCalibration(c: {
    sessionId: string;
    t: number;
    ok: boolean;
    verdict?: string | null;
    anchoring?: string | null;
    divergenceReliable?: boolean | null;
    sourceSignature?: string | null;
    checks?: string | null;
    report?: string | null;
    anchors?: string | null;
  }): number {
    const r = this.db.run(
      `INSERT INTO calibrations (
         session_id, t, ok, verdict, anchoring, divergence_reliable,
         source_signature, checks, report, anchors
       ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      c.sessionId,
      c.t,
      c.ok ? 1 : 0,
      c.verdict ?? null,
      c.anchoring ?? null,
      c.divergenceReliable === null || c.divergenceReliable === undefined
        ? null
        : c.divergenceReliable
          ? 1
          : 0,
      c.sourceSignature ?? null,
      c.checks ?? null,
      c.report ?? null,
      c.anchors ?? null,
    );
    return r.lastInsertRowid;
  }

  calibrations(sessionId: string, limit = 20) {
    return this.db.all(
      'SELECT * FROM calibrations WHERE session_id = ? ORDER BY t DESC LIMIT ?',
      sessionId,
      limit,
    );
  }

  latestCalibration(sessionId: string) {
    return this.db.get<{ divergence_reliable: number | null; source_signature: string | null }>(
      'SELECT * FROM calibrations WHERE session_id = ? ORDER BY t DESC LIMIT 1',
      sessionId,
    );
  }

  // ── Incidents ────────────────────────────────────────────────────────

  openIncident(i: {
    sessionId: string;
    kind: string;
    severity: 'warn' | 'critical';
    summary: string;
    detail?: string;
    payload?: string | null;
    at?: number;
  }): IncidentRow | null {
    // One open incident per kind per session. A stalled feed that stays stalled
    // is one problem, not one problem per monitor tick.
    const existing = this.openIncidentOf(i.sessionId, i.kind);
    if (existing) return null;
    const r = this.db.run(
      `INSERT INTO incidents (session_id, kind, severity, opened_at, summary, detail, payload)
       VALUES (?,?,?,?,?,?,?)`,
      i.sessionId,
      i.kind,
      i.severity,
      i.at ?? Date.now(),
      i.summary,
      i.detail ?? null,
      i.payload ?? null,
    );
    return this.db.get<IncidentRow>('SELECT * FROM incidents WHERE id = ?', r.lastInsertRowid)!;
  }

  openIncidentOf(sessionId: string, kind: string): IncidentRow | undefined {
    return this.db.get<IncidentRow>(
      'SELECT * FROM incidents WHERE session_id = ? AND kind = ? AND closed_at IS NULL',
      sessionId,
      kind,
    );
  }

  closeIncident(sessionId: string, kind: string, at = Date.now()): IncidentRow | null {
    const open = this.openIncidentOf(sessionId, kind);
    if (!open) return null;
    this.db.run('UPDATE incidents SET closed_at = ? WHERE id = ?', at, open.id);
    return { ...open, closed_at: at };
  }

  closeAllIncidents(sessionId: string, at = Date.now()): number {
    return this.db.run(
      'UPDATE incidents SET closed_at = ? WHERE session_id = ? AND closed_at IS NULL',
      at,
      sessionId,
    ).changes;
  }

  incidents(sessionId: string, opts: { openOnly?: boolean; limit?: number } = {}): IncidentRow[] {
    if (opts.openOnly) {
      return this.db.all<IncidentRow>(
        'SELECT * FROM incidents WHERE session_id = ? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT ?',
        sessionId,
        opts.limit ?? 100,
      );
    }
    return this.db.all<IncidentRow>(
      'SELECT * FROM incidents WHERE session_id = ? ORDER BY opened_at DESC LIMIT ?',
      sessionId,
      opts.limit ?? 100,
    );
  }

  allOpenIncidents(limit = 200): IncidentRow[] {
    return this.db.all<IncidentRow>(
      'SELECT * FROM incidents WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT ?',
      limit,
    );
  }
}
