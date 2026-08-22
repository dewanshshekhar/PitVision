/**
 * The Express application.
 *
 * Built separately from the process bootstrap so a test can stand up the whole
 * API against an in-memory database without binding a port.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { type NextFunction, type Request, type Response } from 'express';

import type { Ctx } from './context.ts';
import { HttpError, route, tooMany, unauthorized } from './lib/http.ts';
import { newRequestId } from './lib/ids.ts';
import { clientKey } from './lib/client.ts';
import { healthRoutes } from './routes/health.ts';
import { sessionRoutes } from './routes/sessions.ts';
import { verifyRoutes } from './routes/verify.ts';
import { segmentRoutes } from './routes/segment.ts';
import { streamRoutes } from './routes/stream.ts';
import { opsRoutes } from './routes/ops.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/**
 * Endpoints that are safe without a token even when auth is on.
 *
 * Mount-relative, not absolute: inside a middleware mounted at `/api`,
 * `req.path` has the mount prefix stripped, so `/api/health` never matches and
 * the liveness probe would 401 the moment a token was configured — which a load
 * balancer reads as a dead container and restarts, forever.
 */
const PUBLIC_PATHS = new Set(['/health', '/ready']);

export function createApp(ctx: Ctx): express.Express {
  const app = express();
  app.disable('x-powered-by');
  if (ctx.config.trustProxy) app.set('trust proxy', true);

  // ── Request identity and access logging ──────────────────────────────
  app.use((req: Request, res: Response, next: NextFunction) => {
    req.ctx = ctx;
    req.id = req.get('x-request-id')?.slice(0, 80) || newRequestId();
    req.startedAt = performance.now();
    req.log = ctx.log.child({ reqId: req.id });
    res.setHeader('x-request-id', req.id);

    res.on('finish', () => {
      const ms = performance.now() - req.startedAt;
      ctx.metrics.observeHttp(ms);
      ctx.metrics.inc('pitvision_http_requests_total', 1, {
        method: req.method,
        status: String(res.statusCode),
      });

      // Event streams stay open for the length of a session; logging their
      // duration as a request latency would poison the histogram.
      if (req.path.endsWith('/stream')) return;

      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
      req.log[level]('request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Math.round(ms),
      });
    });

    next();
  });

  // ── Body parsing ─────────────────────────────────────────────────────
  //
  // Two limits, because the two paths are nothing alike. Verification carries a
  // base64 frame and needs room; telemetry ingest carries numbers, and a 12 MB
  // ceiling on it is just an invitation to fill the heap.
  app.use('/api/verify', express.json({ limit: '12mb' }));
  app.use('/api/segment', express.json({ limit: '12mb' }));
  app.use('/api', express.json({ limit: '1mb' }));

  // ── Auth ─────────────────────────────────────────────────────────────
  //
  // Off by default: the common deployment is a laptop in a garage serving
  // itself. Setting PITVISION_API_TOKEN turns it on for everything that is not
  // a health check, which is what you want the moment the port is reachable by
  // anything other than localhost.
  app.use('/api', (req, _res, next) => {
    if (!ctx.config.apiToken || PUBLIC_PATHS.has(req.path)) return next();
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token as string) ?? '';
    if (token !== ctx.config.apiToken) {
      ctx.metrics.inc('pitvision_unauthorized_total');
      return next(unauthorized());
    }
    next();
  });

  // ── Ingest rate limit ────────────────────────────────────────────────
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.path === '/verify') return next();
    const wait = ctx.limiters.ingest.check(clientKey(req, ctx.config.trustProxy));
    if (wait === null) return next();
    ctx.metrics.inc('pitvision_rate_limited_total', 1, { route: 'ingest' });
    res.setHeader('retry-after', String(wait));
    next(tooMany(`Ingest is limited to ${ctx.config.ingestRateLimit} requests per minute.`, wait));
  });

  // ── Routes ───────────────────────────────────────────────────────────
  app.use('/api', healthRoutes(ctx));
  app.use('/api', opsRoutes(ctx));
  app.use('/api', streamRoutes(ctx));
  app.use('/api', sessionRoutes(ctx));
  app.use('/api', verifyRoutes(ctx));
  // Frames go to the segmenter, so it shares the verify body limit.
  app.use('/api', segmentRoutes(ctx));

  app.use(
    '/api',
    route((req) => {
      throw new HttpError(404, 'not_found', `No route ${req.method} ${req.originalUrl}.`);
    }),
  );

  // ── Static build ─────────────────────────────────────────────────────
  const dist = join(root, 'dist');
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
  }

  // ── Errors ───────────────────────────────────────────────────────────
  //
  // One shape for every failure, with the request id in it, so a report of
  // "it broke" can be matched to a log line without guessing.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status =
      err instanceof HttpError
        ? err.status
        : Number.isInteger((err as { status?: number }).status)
          ? (err as { status: number }).status
          : 500;

    const code = err instanceof HttpError ? err.code : status >= 500 ? 'internal' : 'request_failed';
    const message = (err as Error)?.message ?? 'Unexpected error.';

    // An HttpError is a decision this server made deliberately — "no key
    // configured", "session already ended". It is 500-level on the wire but it
    // is not a fault, and logging a stack trace for each one buries the
    // failures that are. Anything else at 500 is genuinely unexpected.
    if (err instanceof HttpError) {
      if (status >= 400) {
        req.log?.warn('request rejected', { path: req.path, status, code, message });
      }
    } else if (status >= 500) {
      req.log?.error('request failed', { path: req.path, status, err });
    }
    if (status >= 500) ctx.metrics.inc('pitvision_errors_total', 1, { code });

    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(status).json({
      error: message,
      code,
      requestId: req.id,
      ...(err instanceof HttpError && err.details ? { details: err.details } : {}),
    });
  });

  return app;
}
