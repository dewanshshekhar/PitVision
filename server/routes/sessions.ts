import { Router } from 'express';

import type { Ctx } from '../context.ts';
import { badRequest, body, conflict, notFound, param, route } from '../lib/http.ts';
import { buildReport } from '../services/report.ts';
import { CONDITIONS, isCondition, type Condition } from '../domain/conditions.ts';
import type { SessionRow, SessionStatus } from '../services/store.ts';

const SOURCE_KINDS = ['file', 'url', 'camera', 'screen', 'synthetic', 'video', 'none'] as const;
const MAX_READINGS_PER_BATCH = 2000;
const MAX_EVENTS_PER_BATCH = 200;

/** Trim the internal row shape down to what a client should see. */
function present(s: SessionRow) {
  return {
    id: s.id,
    status: s.status,
    createdAt: s.created_at,
    startedAt: s.started_at,
    endedAt: s.ended_at,
    lastSeenAt: s.last_seen_at,
    endReason: s.end_reason,
    source: { kind: s.source_kind, label: s.source_label, signature: s.source_signature },
    entrant: {
      driver: s.driver,
      number: s.car_number,
      team: s.team,
      car: s.car,
      circuit: s.circuit,
      session: s.session_name,
    },
    baselineLapS: s.baseline_lap_s,
    appVersion: s.app_version,
  };
}

export function sessionRoutes(ctx: Ctx): Router {
  const r = Router();

  /** Look up a session or fail with a message that names the id. */
  function must(id: string): SessionRow {
    const s = ctx.store.getSession(id);
    if (!s) throw notFound(`No session \`${id}\`.`);
    return s;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  r.post(
    '/sessions',
    route((req, res) => {
      const b = body(req);
      const source = b.obj('source');
      const entrant = b.obj('entrant', { optional: true });

      const session = ctx.store.createSession({
        sourceKind: source!.str('kind', { enum: SOURCE_KINDS }),
        sourceLabel: source!.str('label', { optional: true, max: 300 }),
        sourceSignature: source!.str('signature', { optional: true, max: 300 }),
        driver: entrant?.str('driver', { optional: true, max: 120 }),
        carNumber: entrant?.str('number', { optional: true, max: 20 }),
        team: entrant?.str('team', { optional: true, max: 120 }),
        car: entrant?.str('car', { optional: true, max: 120 }),
        circuit: entrant?.str('circuit', { optional: true, max: 120 }),
        sessionName: entrant?.str('session', { optional: true, max: 120 }),
        baselineLapS: b.num('baselineLapS', { min: 0, max: 3600, default: 0 }) || undefined,
        clientId: b.str('clientId', { optional: true, max: 120 }),
        appVersion: b.str('appVersion', { optional: true, max: 40 }),
        userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
      });

      ctx.monitor.observeCalibration(session.id, session.source_signature);
      ctx.metrics.inc('pitvision_sessions_started_total');
      req.log.info('session started', {
        sessionId: session.id,
        source: session.source_kind,
        circuit: session.circuit,
      });
      ctx.bus.publish({ type: 'session.started', sessionId: session.id, data: present(session) });

      res.status(201).json({ session: present(session) });
    }),
  );

  r.get(
    '/sessions',
    route((req, res) => {
      const limit = clampInt(req.query.limit, 50, 1, 500);
      const offset = clampInt(req.query.offset, 0, 0, 1_000_000);
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      if (status && !['active', 'ended', 'abandoned'].includes(status)) {
        throw badRequest('`status` must be active, ended or abandoned.');
      }

      const rows = ctx.store.listSessions({ limit, offset, status: status as SessionStatus });
      res.json({
        sessions: rows.map(present),
        total: ctx.store.countSessions(status as SessionStatus),
        limit,
        offset,
      });
    }),
  );

  r.get(
    '/sessions/:id',
    route((req, res) => {
      const s = must(param(req, 'id'));
      const latest = ctx.store.latestReading(s.id);
      res.json({
        session: present(s),
        readings: ctx.store.countReadings(s.id),
        latest: latest
          ? {
              t: latest.t,
              condition: latest.condition,
              wetness: latest.wetness,
              line: latest.line,
              edge: latest.edge,
              divergence: latest.divergence,
              trend: latest.trend,
            }
          : null,
        openIncidents: ctx.store.incidents(s.id, { openOnly: true }),
      });
    }),
  );

  r.patch(
    '/sessions/:id',
    route((req, res) => {
      const s = must(param(req, 'id'));
      const b = body(req);
      const patch: Record<string, string | number | null> = {};

      const entrant = b.obj('entrant', { optional: true });
      if (entrant) {
        const map: [string, string][] = [
          ['driver', 'driver'],
          ['number', 'car_number'],
          ['team', 'team'],
          ['car', 'car'],
          ['circuit', 'circuit'],
          ['session', 'session_name'],
        ];
        for (const [from, column] of map) {
          const v = entrant.str(from, { optional: true, max: 120 });
          if (v) patch[column] = v;
        }
      }

      const source = b.obj('source', { optional: true });
      if (source) {
        const label = source.str('label', { optional: true, max: 300 });
        const signature = source.str('signature', { optional: true, max: 300 });
        if (label) patch.source_label = label;
        if (signature) patch.source_signature = signature;
      }

      const baseline = b.num('baselineLapS', { min: 0, max: 3600, default: -1 });
      if (baseline >= 0) patch.baseline_lap_s = baseline;

      const notes = b.str('notes', { optional: true, max: 4000 });
      if (notes) patch.notes = notes;

      ctx.store.updateSession(s.id, patch);
      res.json({ session: present(must(s.id)), updated: Object.keys(patch) });
    }),
  );

  r.post(
    '/sessions/:id/end',
    route((req, res) => {
      const s = must(param(req, 'id'));
      if (s.status !== 'active') {
        throw conflict(`Session \`${s.id}\` is already ${s.status}.`);
      }
      const reason = body(req).str('reason', { optional: true, max: 200 }) || 'client ended session';

      ctx.store.endSession(s.id, reason);
      ctx.store.closeAllIncidents(s.id);
      ctx.monitor.forget(s.id);
      ctx.metrics.inc('pitvision_sessions_ended_total');
      req.log.info('session ended', { sessionId: s.id, reason });
      ctx.bus.publish({ type: 'session.ended', sessionId: s.id, data: { reason, status: 'ended' } });

      const ended = must(s.id);
      res.json({ session: present(ended), report: buildReport(ctx.store, ended, ctx.config) });
    }),
  );

  // ── Ingest ───────────────────────────────────────────────────────────

  /**
   * Batched readings.
   *
   * The engine commits a reading on every analysed frame — up to 25 a second.
   * Posting each one would put an HTTP round trip on a path whose entire design
   * goal is a 100 ms budget, so the client downsamples to ~1 Hz and batches.
   * The series that matters for weather is fully preserved at that rate; what
   * is lost is per-frame noise, which the smoothed index already discards.
   */
  r.post(
    '/sessions/:id/readings',
    route((req, res) => {
      const s = must(param(req, 'id'));
      if (s.status !== 'active') throw conflict(`Session \`${s.id}\` is ${s.status}; it accepts no more readings.`);

      const b = body(req);
      const items = b.arr('readings', { max: MAX_READINGS_PER_BATCH });
      const now = Date.now();

      const rows = items.map((f) => {
        const condition = f.str('condition');
        if (!isCondition(condition)) {
          throw badRequest(`Unknown condition \`${condition}\`. Expected one of: ${CONDITIONS.join(', ')}.`);
        }
        const signals = f.obj('signals', { optional: true });
        const normalised = f.obj('normalised', { optional: true });

        return {
          // A client clock can be anything at all. Timestamps far in the future
          // would sort ahead of everything and make the series unreadable, so
          // they are pulled back to arrival time rather than trusted.
          t: Math.min(f.num('t', { min: 0 }), now + 5000),
          wetness: f.num('wetness', { min: -1, max: 101 }),
          wetnessRaw: f.num('wetnessRaw', { min: -1, max: 101 }),
          line: f.num('line', { min: -1, max: 101 }),
          edge: f.num('edge', { min: -1, max: 101 }),
          divergence: f.num('divergence', { min: -200, max: 200 }),
          condition: condition as Condition,
          trend: f.num('trend', { min: -100_000, max: 100_000 }),
          signals: signals
            ? {
                glare: signals.num('glare', { default: 0 }),
                texture: signals.num('texture', { default: 0 }),
                darkness: signals.num('darkness', { default: 0 }),
                specular: signals.num('specular', { default: 0 }),
              }
            : undefined,
          normalised: normalised
            ? {
                glare: normalised.num('glare', { default: 0 }),
                texture: normalised.num('texture', { default: 0 }),
                darkness: normalised.num('darkness', { default: 0 }),
                specular: normalised.num('specular', { default: 0 }),
              }
            : undefined,
          analysisMs: f.num('analysisMs', { min: 0, max: 60_000, default: 0 }) || undefined,
          latencyMs: f.num('latencyMs', { min: 0, max: 60_000, default: 0 }) || undefined,
        };
      });

      const signature = b.str('sourceSignature', { optional: true, max: 300 });
      const written = ctx.store.insertReadings(s.id, rows);
      ctx.store.touchSession(s.id);
      ctx.monitor.observeReadings(s.id, rows, signature || undefined);
      ctx.metrics.observeIngest(written);
      ctx.metrics.inc('pitvision_readings_ingested_total', written);

      // Only the newest reading is fanned out. A live viewer wants the current
      // state, not a replay of the last second at full rate.
      const newest = rows[rows.length - 1];
      if (newest) ctx.bus.publish({ type: 'reading', sessionId: s.id, data: newest });

      res.status(202).json({ accepted: written });
    }),
  );

  r.post(
    '/sessions/:id/events',
    route((req, res) => {
      const s = must(param(req, 'id'));
      const items = body(req).arr('events', { max: MAX_EVENTS_PER_BATCH });
      const now = Date.now();

      const rows = items.map((f) => ({
        t: Math.min(f.num('t', { min: 0, default: now }), now + 5000),
        origin: 'client' as const,
        kind: f.str('kind', { max: 40 }),
        level: f.str('level', { enum: ['info', 'warn', 'critical'] }) as 'info' | 'warn' | 'critical',
        title: f.str('title', { max: 200 }),
        detail: f.str('detail', { optional: true, max: 2000 }),
        payload: f.json('payload', 8000),
      }));

      const written = ctx.store.insertEvents(s.id, rows);
      ctx.store.touchSession(s.id);
      ctx.metrics.inc('pitvision_events_ingested_total', written);
      for (const e of rows) ctx.bus.publish({ type: 'event', sessionId: s.id, data: e });

      res.status(202).json({ accepted: written });
    }),
  );

  /**
   * A pre-race check result.
   *
   * Stored because a disputed reading is almost always a disputed calibration,
   * and the anchors are the only way to re-derive what the index meant at the
   * time. Without them a stored wetness of 62 is a number with no units.
   */
  r.post(
    '/sessions/:id/calibration',
    route((req, res) => {
      const s = must(param(req, 'id'));
      const b = body(req);

      const signature = b.str('sourceSignature', { optional: true, max: 300 });
      const divergenceReliable = b.bool('divergenceReliable', true);

      const id = ctx.store.insertCalibration({
        sessionId: s.id,
        t: Date.now(),
        ok: b.bool('ok', false),
        verdict: b.str('verdict', { optional: true, max: 200 }) || null,
        anchoring: b.str('anchoring', { optional: true, max: 60 }) || null,
        divergenceReliable,
        sourceSignature: signature || null,
        checks: b.json('checks', 32_000),
        report: b.json('report', 64_000),
        anchors: b.json('anchors', 8000),
      });

      if (signature) {
        ctx.store.updateSession(s.id, { source_signature: signature });
        ctx.monitor.observeCalibration(s.id, signature);
      }
      ctx.store.touchSession(s.id);
      ctx.metrics.inc('pitvision_calibrations_total');
      ctx.bus.publish({ type: 'calibration', sessionId: s.id, data: { id, ok: b.bool('ok', false) } });

      res.status(201).json({ id });
    }),
  );

  // ── Reads ────────────────────────────────────────────────────────────

  r.get(
    '/sessions/:id/readings',
    route((req, res) => {
      const s = must(param(req, 'id'));
      const rows = ctx.store.readings(s.id, {
        from: clampInt(req.query.from, 0, 0, Number.MAX_SAFE_INTEGER),
        to: clampInt(req.query.to, Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER),
        limit: clampInt(req.query.limit, 5000, 1, 100_000),
      });
      res.json({ sessionId: s.id, count: rows.length, readings: rows });
    }),
  );

  r.get(
    '/sessions/:id/events',
    route((req, res) => {
      const s = must(param(req, 'id'));
      res.json({ events: ctx.store.events(s.id, clampInt(req.query.limit, 200, 1, 5000)) });
    }),
  );

  r.get(
    '/sessions/:id/verifications',
    route((req, res) => {
      const s = must(param(req, 'id'));
      res.json({
        verifications: ctx.store.verifications(s.id, clampInt(req.query.limit, 100, 1, 5000)),
      });
    }),
  );

  r.get(
    '/sessions/:id/incidents',
    route((req, res) => {
      const s = must(param(req, 'id'));
      res.json({
        incidents: ctx.store.incidents(s.id, {
          openOnly: req.query.open === 'true',
          limit: clampInt(req.query.limit, 100, 1, 1000),
        }),
      });
    }),
  );

  r.get(
    '/sessions/:id/calibration',
    route((req, res) => {
      const s = must(param(req, 'id'));
      res.json({ calibrations: ctx.store.calibrations(s.id, clampInt(req.query.limit, 20, 1, 200)) });
    }),
  );

  r.get(
    '/sessions/:id/report',
    route((req, res) => {
      const s = must(param(req, 'id'));
      res.json(buildReport(ctx.store, s, ctx.config));
    }),
  );

  return r;
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
