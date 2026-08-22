/**
 * PitVision backend.
 *
 * Serves the built app, records everything a session produces, watches the
 * detector while it runs, and turns the result into a report you can read
 * afterwards. The AI verification proxy is one endpoint inside it, not the
 * whole of it.
 *
 *   node server/index.ts
 *
 * No build step: Node strips the types.
 */

import 'dotenv/config';

import { loadConfig } from './config.ts';
import type { Ctx } from './context.ts';
import { createApp } from './app.ts';
import { openDb, pruneOldData } from './db/index.ts';
import { createLogger } from './lib/log.ts';
import { RateLimiter } from './lib/ratelimit.ts';
import { Bus } from './services/bus.ts';
import { Metrics } from './services/metrics.ts';
import { Monitor } from './services/monitor.ts';
import { Store } from './services/store.ts';
import { VerificationService } from './services/verification.ts';
import { PitWallService } from './services/pitwall.ts';

const config = (() => {
  try {
    return loadConfig();
  } catch (err) {
    console.error(`Configuration error: ${(err as Error).message}`);
    process.exit(78); // EX_CONFIG
  }
})();

const log = createLogger(config.logLevel, config.env !== 'production');

const db = openDb(config.dbPath, log);
const store = new Store(db);
const metrics = new Metrics();
const bus = new Bus(log.child({ component: 'bus' }));
const monitor = new Monitor(store, bus, metrics, config, log.child({ component: 'monitor' }));
const verification = new VerificationService(
  store,
  metrics,
  bus,
  monitor,
  config,
  log.child({ component: 'verify' }),
);
const pitwall = new PitWallService(config, log.child({ component: 'pitwall' }));

const ctx: Ctx = {
  config,
  log,
  db,
  store,
  bus,
  monitor,
  metrics,
  verification,
  pitwall,
  limiters: {
    verify: new RateLimiter(config.verifyRateLimit),
    ingest: new RateLimiter(config.ingestRateLimit),
  },
};

const app = createApp(ctx);
monitor.start();

// Housekeeping: retention and limiter buckets. Hourly is often enough for both
// and cheap enough not to think about.
const housekeeping = setInterval(
  () => {
    try {
      pruneOldData(db, config.retentionDays, log);
      ctx.limiters.verify.sweep();
      ctx.limiters.ingest.sweep();
    } catch (err) {
      log.error('housekeeping failed', { err });
    }
  },
  60 * 60 * 1000,
);
housekeeping.unref?.();

const server = app.listen(config.port, config.host, () => {
  log.info('pitvision backend listening', {
    url: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`,
    env: config.env,
    db: config.dbPath,
    model: config.model,
    verification: verification.configured ? 'configured' : 'NO KEY — /api/verify returns 503',
    auth: config.apiToken ? 'token required' : 'open (no PITVISION_API_TOKEN set)',
  });
});

// Long enough for a verification round trip to finish, short enough that a
// deploy is not held up by an idle keep-alive.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

// ── Shutdown ───────────────────────────────────────────────────────────
//
// Active sessions are left active rather than ended: a container restart is not
// the end of a race session, and the monitor re-adopts them on the way back up.
// Marking them ended here would truncate every report across a deploy.

let shuttingDown = false;

async function shutdown(signal: string, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });

  clearInterval(housekeeping);
  monitor.stop();
  bus.close();

  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 8000).unref?.());
  await Promise.race([closed, timeout]);

  try {
    db.close();
  } catch (err) {
    log.error('database close failed', { err });
  }

  log.info('shutdown complete');
  process.exit(code);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { err: reason });
});

process.on('uncaughtException', (err) => {
  // The process state is unknown after this, so it goes down — but it goes down
  // having flushed the database, which is where the session record lives.
  log.error('uncaught exception', { err });
  void shutdown('uncaughtException', 1);
});
