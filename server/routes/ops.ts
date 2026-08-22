import { Router } from 'express';

import type { Ctx } from '../context.ts';
import { route } from '../lib/http.ts';

/**
 * Operations endpoints: what a human or a scrape looks at to see whether the
 * whole thing is working, without opening a session.
 */
export function opsRoutes(ctx: Ctx): Router {
  const r = Router();

  r.get(
    '/metrics',
    route((_req, res) => {
      res.type('text/plain; version=0.0.4').send(ctx.metrics.render());
    }),
  );

  /** The same picture as /metrics, shaped for a dashboard rather than a scraper. */
  r.get(
    '/stats',
    route((_req, res) => {
      const active = ctx.store.activeSessions();
      const open = ctx.store.allOpenIncidents();

      res.json({
        ...ctx.metrics.snapshot(),
        sessions: {
          active: active.length,
          total: ctx.store.countSessions(),
          list: active.map((s) => ({
            id: s.id,
            circuit: s.circuit,
            driver: s.driver,
            source: s.source_kind,
            startedAt: s.started_at,
            lastSeenAt: s.last_seen_at,
            staleMs: Date.now() - s.last_seen_at,
          })),
        },
        incidents: {
          open: open.length,
          byKind: open.reduce<Record<string, number>>((acc, i) => {
            acc[i.kind] = (acc[i.kind] ?? 0) + 1;
            return acc;
          }, {}),
          list: open,
        },
        verification: {
          configured: ctx.verification.configured,
          model: ctx.config.model,
          p95Ms: ctx.metrics.verifyP95,
        },
      });
    }),
  );

  /** Everything currently wrong, across every session. The one page to check. */
  r.get(
    '/incidents',
    route((_req, res) => {
      res.json({ incidents: ctx.store.allOpenIncidents() });
    }),
  );

  return r;
}
