import { Router } from 'express';

import type { Ctx } from '../context.ts';
import { body, route, badRequest } from '../lib/http.ts';

export function pitwallRoutes(ctx: Ctx): Router {
  const r = Router();

  r.post(
    '/pitwall',
    route(async (req, res) => {
      const b = body(req);
      const track = b.obj('track');
      if (!track) throw badRequest('`track` object is required.');
      const tyre = b.obj('tyre', { optional: true });
      const sessionId = b.str('sessionId', { optional: true, max: 60 }) || null;

      const trackData = {
        wetness: track.num('wetness', { default: 0 }),
        trend: track.num('trend', { default: 0 }),
        condition: track.str('condition', { optional: true }) || 'Dry',
        divergence: track.num('divergence', { default: 0 }),
        glare: track.num('glare', { default: 0 }),
        texture: track.num('texture', { default: 0 }),
      };

      const tyreData = tyre
        ? {
            compound: tyre.str('compound', { optional: true }),
            ageLaps: tyre.num('ageLaps', { default: 0 }),
            lifePct: tyre.num('lifePct', { default: 100 }),
            tempFl: tyre.num('tempFl', { default: 100 }),
            tempFr: tyre.num('tempFr', { default: 100 }),
            tempRl: tyre.num('tempRl', { default: 100 }),
            tempRr: tyre.num('tempRr', { default: 100 }),
            currentLap: tyre.num('currentLap', { default: 1 }),
            totalLaps: tyre.num('totalLaps', { default: 50 }),
          }
        : undefined;

      const result = await ctx.pitwall.advise({
        track: trackData,
        tyre: tyreData,
        sessionId,
      });

      if (sessionId) ctx.store.touchSession(sessionId);

      res.json(result);
    }),
  );

  return r;
}
