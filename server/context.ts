import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import type { Logger } from './lib/log.ts';
import type { RateLimiter } from './lib/ratelimit.ts';
import type { Bus } from './services/bus.ts';
import type { Metrics } from './services/metrics.ts';
import type { Monitor } from './services/monitor.ts';
import type { Store } from './services/store.ts';
import type { VerificationService } from './services/verification.ts';

/** Everything a route handler is allowed to reach. Wired once, in index.ts. */
export interface Ctx {
  config: Config;
  log: Logger;
  db: Db;
  store: Store;
  bus: Bus;
  monitor: Monitor;
  metrics: Metrics;
  verification: VerificationService;
  limiters: { verify: RateLimiter; ingest: RateLimiter };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx: Ctx;
      id: string;
      log: Logger;
      startedAt: number;
    }
  }
}
