import { Router } from 'express';

import type { Ctx } from '../context.ts';
import { route } from '../lib/http.ts';

/**
 * Two endpoints, because they answer different questions.
 *
 * `/api/health` is liveness: the process is up and serving. A load balancer
 * uses it to decide whether to restart the container, so it must not fail for
 * a missing API key — restarting will not produce one.
 *
 * `/api/ready` is readiness: everything this server needs in order to do its
 * job actually works, checked rather than assumed. The old health check
 * reported `configured: true` whenever the environment variable was non-empty,
 * which is true of a revoked key, a typo and a key for the wrong account.
 */
export function healthRoutes(ctx: Ctx): Router {
  const r = Router();

  r.get(
    '/health',
    route((_req, res) => {
      res.json({
        ok: true,
        status: 'live',
        // Retained for the existing client, which reads `configured` and `model`.
        configured: ctx.verification.configured,
        model: ctx.config.model,
        uptimeSec: Math.round(process.uptime()),
        version: 3,
      });
    }),
  );

  r.get(
    '/ready',
    route((_req, res) => {
      const checks: Record<string, { ok: boolean; detail: string }> = {};

      try {
        const row = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions');
        checks.database = { ok: true, detail: `reachable, ${row?.n ?? 0} sessions stored` };
      } catch (err) {
        checks.database = { ok: false, detail: (err as Error).message };
      }

      try {
        // A read proves the file is there; only a write proves the disk is not
        // full and the process can still record a session.
        ctx.db.run(
          "CREATE TABLE IF NOT EXISTS _writecheck (id INTEGER PRIMARY KEY, at INTEGER)",
        );
        ctx.db.run('INSERT OR REPLACE INTO _writecheck (id, at) VALUES (1, ?)', Date.now());
        checks.writable = { ok: true, detail: 'database accepts writes' };
      } catch (err) {
        checks.writable = { ok: false, detail: (err as Error).message };
      }

      checks.verification = ctx.verification.configured
        ? { ok: true, detail: `key present, model ${ctx.config.model}` }
        : { ok: false, detail: 'ANTHROPIC_API_KEY not set — verification returns 503' };

      const active = ctx.store.countSessions('active');
      checks.monitor = { ok: true, detail: `watching ${active} active session(s)` };

      // Verification being down is degraded, not dead: the CV readout is
      // unaffected and taking the server out of rotation would make it worse.
      const critical = checks.database.ok && checks.writable.ok;
      res.status(critical ? 200 : 503).json({
        ok: critical,
        status: critical ? (checks.verification.ok ? 'ready' : 'degraded') : 'unready',
        checks,
      });
    }),
  );

  return r;
}
