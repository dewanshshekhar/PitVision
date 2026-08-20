import { Router } from 'express';

import type { Ctx } from '../context.ts';
import { body, route } from '../lib/http.ts';

/**
 * Proxy to the road-segmentation sidecar.
 *
 * The browser could call the Python service directly, but routing it through
 * here means one origin, one port and one thing to configure — and it lets the
 * backend report the sidecar's health alongside its own, so "why is the lane
 * not being traced" has a single place to look.
 *
 * The important behaviour is what happens when the sidecar is *not* there,
 * which is the common case: most deployments will never install a model. Every
 * failure returns 200 with `corridor: null` and a reason, because a missing
 * sidecar is not an error — the detector falls back to the in-browser geometric
 * tracer and carries on. Returning a 5xx would put an error in the client's
 * console every few seconds for a configuration that is working as intended.
 */

/** Long enough for a CPU inference, short enough not to stack up behind one. */
const TIMEOUT_MS = 2500;

/**
 * After this many consecutive failures the proxy stops trying for a while.
 *
 * Without it, a browser polling four times a second against a sidecar that is
 * not running produces a connection attempt every 250 ms for the length of the
 * session. The client already falls back on the first failure; the breaker
 * stops the backend from doing pointless work behind it.
 */
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 20_000;

interface Breaker {
  failures: number;
  openUntil: number;
}

export function segmentRoutes(ctx: Ctx): Router {
  const r = Router();
  const breaker: Breaker = { failures: 0, openUntil: 0 };
  const base = ctx.config.segmenterUrl;

  const unavailable = (reason: string) => ({ corridor: null, reason, source: 'unavailable' });

  r.get(
    '/segment/health',
    route(async (_req, res) => {
      if (!base) {
        res.json({ configured: false, reason: 'PITVISION_SEGMENTER_URL is not set' });
        return;
      }
      try {
        const upstream = await fetch(`${base}/health`, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        res.json({ configured: true, ok: upstream.ok, upstream: await upstream.json() });
      } catch (err) {
        res.json({
          configured: true,
          ok: false,
          reason: (err as Error).message,
          breakerOpen: Date.now() < breaker.openUntil,
        });
      }
    }),
  );

  r.post(
    '/segment',
    route(async (req, res) => {
      // Validate before checking whether there is anywhere to send it.
      //
      // A request with no image is a client bug whether or not a segmenter is
      // installed, and most installs have none — so answering "no segmenter
      // configured" first would hide the bug until the day someone installs a
      // model, which is the worst possible day to discover it.
      const image = body(req).str('image', { max: 16_000_000 });

      if (!base) {
        res.json(unavailable('no segmenter configured'));
        return;
      }
      if (Date.now() < breaker.openUntil) {
        res.json(unavailable('segmenter unreachable; retrying shortly'));
        return;
      }

      try {
        const upstream = await fetch(`${base}/segment`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ image }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        // A 4xx means *this request* was bad — an unreadable frame, a body the
        // sidecar rejected. That is not the sidecar being down, and counting it
        // toward the breaker would let a handful of malformed frames disable
        // road segmentation for the next twenty seconds. Only transport
        // failures and 5xx say anything about whether the sidecar is alive.
        if (upstream.status >= 400 && upstream.status < 500) {
          breaker.failures = 0;
          const detail = (await upstream.json().catch(() => null)) as { error?: string } | null;
          ctx.metrics.inc('pitvision_segment_requests_total', 1, { result: 'rejected' });
          res.json({
            corridor: null,
            reason: detail?.error ?? `segmenter rejected the frame (${upstream.status})`,
            source: 'rejected',
          });
          return;
        }

        if (!upstream.ok) {
          throw new Error(`segmenter responded ${upstream.status}`);
        }

        breaker.failures = 0;
        const payload = (await upstream.json()) as Record<string, unknown>;
        ctx.metrics.inc('pitvision_segment_requests_total', 1, {
          result: payload.corridor ? 'corridor' : 'refused',
        });
        res.json(payload);
      } catch (err) {
        breaker.failures++;
        if (breaker.failures >= BREAKER_THRESHOLD) {
          breaker.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
          breaker.failures = 0;
          req.log.warn('segmenter breaker opened', { cooldownMs: BREAKER_COOLDOWN_MS });
        }
        ctx.metrics.inc('pitvision_segment_requests_total', 1, { result: 'error' });
        res.json(unavailable((err as Error).message));
      }
    }),
  );

  return r;
}
