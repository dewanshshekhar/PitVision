import { Router } from 'express';

import type { Ctx } from '../context.ts';
import { notFound, param, route } from '../lib/http.ts';

/**
 * Live streams.
 *
 * A session stream is for a second screen on the pit wall: the same readout as
 * the tab holding the footage, without needing the footage. The global stream
 * is the operations view — every session, every incident, one place to look
 * when several cars are running.
 *
 * Each subscriber gets a snapshot first and deltas after, so a client that
 * connects mid-session is immediately correct rather than blank until the next
 * event fires.
 */
export function streamRoutes(ctx: Ctx): Router {
  const r = Router();

  r.get(
    '/sessions/:id/stream',
    route((req, res) => {
      const id = param(req, 'id');
      const session = ctx.store.getSession(id);
      if (!session) throw notFound(`No session \`${id}\`.`);

      // Express times out idle sockets; an event stream is idle by nature.
      req.socket.setTimeout(0);
      req.socket.setKeepAlive(true);
      res.setHeader('x-session-id', session.id);

      ctx.bus.subscribe(res, session.id);
      ctx.metrics.inc('pitvision_sse_connections_total');

      res.write(
        `event: snapshot\ndata: ${JSON.stringify({
          type: 'snapshot',
          sessionId: session.id,
          at: Date.now(),
          data: {
            session,
            latest: ctx.store.latestReading(session.id),
            openIncidents: ctx.store.incidents(session.id, { openOnly: true }),
            recentEvents: ctx.store.events(session.id, 20),
          },
        })}\n\n`,
      );
    }),
  );

  r.get(
    '/stream',
    route((req, res) => {
      req.socket.setTimeout(0);
      req.socket.setKeepAlive(true);

      ctx.bus.subscribe(res, '*');
      ctx.metrics.inc('pitvision_sse_connections_total');

      res.write(
        `event: snapshot\ndata: ${JSON.stringify({
          type: 'snapshot',
          sessionId: null,
          at: Date.now(),
          data: {
            active: ctx.store.activeSessions(),
            openIncidents: ctx.store.allOpenIncidents(),
          },
        })}\n\n`,
      );
    }),
  );

  return r;
}
