import { Router } from 'express';

import type { Ctx } from '../context.ts';
import { body, route, tooMany } from '../lib/http.ts';
import { clientKey } from '../lib/client.ts';

/**
 * The verification endpoint.
 *
 * The request and response shapes are unchanged from the original proxy, so an
 * older build of the client keeps working. What has been added around them is
 * a rate limit — this is the one endpoint that spends money per call, and an
 * open port with a retry loop behind it is a bill, not an outage.
 */
export function verifyRoutes(ctx: Ctx): Router {
  const r = Router();

  r.post(
    '/verify',
    route(async (req, res) => {
      const key = clientKey(req, ctx.config.trustProxy);
      const wait = ctx.limiters.verify.check(key);
      if (wait !== null) {
        ctx.metrics.inc('pitvision_rate_limited_total', 1, { route: 'verify' });
        res.setHeader('retry-after', String(wait));
        throw tooMany(
          `Verification is limited to ${ctx.config.verifyRateLimit} calls per minute per client.`,
          wait,
        );
      }

      const b = body(req);
      const image = b.str('image', { max: 16_000_000 });
      const sessionId = b.str('sessionId', { optional: true, max: 60 }) || null;
      const cv = b.obj('cv', { optional: true });

      const result = await ctx.verification.verify({
        image,
        sessionId,
        cv: cv
          ? {
              condition: cv.str('condition', { optional: true, max: 40 }),
              wetness: cv.num('wetness', { default: 0 }),
              racingLine: cv.num('racingLine', { default: 0 }),
              trackEdges: cv.num('trackEdges', { default: 0 }),
              divergence: cv.num('divergence', { default: 0 }),
              trendPerMin: cv.num('trendPerMin', { default: 0 }),
            }
          : null,
      });

      if (sessionId) ctx.store.touchSession(sessionId);

      res.json({
        // Original contract.
        condition: result.condition,
        confidence: result.confidence,
        reasoning: result.reasoning,
        model: result.model,
        usage: result.usage,
        // Added: the graded verdict and the audit row it was written to.
        id: result.id,
        agreement: result.agreement,
        agrees: result.agrees,
        latencyMs: result.latencyMs,
        costUsd: result.costUsd,
      });
    }),
  );

  return r;
}
