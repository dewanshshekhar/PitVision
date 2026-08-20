/**
 * Configuration, parsed and validated once at boot.
 *
 * Everything the server can be tuned with lives here, so a misconfiguration
 * fails at startup with a named field rather than at 3am with a stack trace
 * from somewhere in the middle of a session.
 */

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function num(name: string, fallback: number, { min = -Infinity, max = Infinity } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${name} must be a number, got "${raw}"`);
  if (v < min || v > max) throw new Error(`${name} must be between ${min} and ${max}, got ${v}`);
  return v;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be a boolean, got "${raw}"`);
}

export interface MonitorThresholds {
  /** No reading for this long on an active session means the feed has stalled. */
  stallMs: number;
  /** End-to-end latency budget, milliseconds. Breaching p95 opens an incident. */
  latencyBudgetMs: number;
  /** Fraction of the recent window allowed to breach the budget before it counts. */
  latencyBreachRatio: number;
  /** Comparable verifications needed before an agreement rate means anything. */
  driftMinSamples: number;
  /** Agreement rate below this over the window opens a drift incident. */
  driftFloor: number;
  /** Consecutive verification failures before the AI path is declared down. */
  verifyFailStreak: number;
  /** Condition changes within `instabilityWindowMs` that count as strobing. */
  instabilityFlips: number;
  instabilityWindowMs: number;
  /** Sustained wetness trend (index points/min) that counts as a real weather event. */
  surgePerMin: number;
  /** How long the lane tracer may be lost before the readings stop being trustworthy. */
  laneLostMs: number;
}

export interface Config {
  port: number;
  host: string;
  env: string;
  dbPath: string;
  /** Bearer token required on write endpoints. Empty means auth is off. */
  apiToken: string;
  anthropicKey: string;
  model: string;
  /** Hard ceiling on one Anthropic call, milliseconds. */
  verifyTimeoutMs: number;
  verifyRetries: number;
  /** Verification calls allowed per client per minute — this endpoint costs money. */
  verifyRateLimit: number;
  ingestRateLimit: number;
  /** Readings older than this are pruned from the hot table on a schedule. */
  retentionDays: number;
  /** How often the monitor sweeps active sessions. */
  monitorTickMs: number;
  /** Sessions with no traffic for this long are auto-closed as abandoned. */
  sessionIdleMs: number;
  /**
   * Base URL of the road-segmentation sidecar, or empty when there is none.
   *
   * Optional by design. Without it the detector uses the in-browser geometric
   * tracer, which is the configuration most deployments will run.
   */
  segmenterUrl: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  trustProxy: boolean;
  monitor: MonitorThresholds;
  /** USD per million tokens, for cost accounting on verification. */
  pricing: { inputPerMTok: number; outputPerMTok: number };
}

export function loadConfig(): Config {
  const logLevel = str('LOG_LEVEL', 'info');
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new Error(`LOG_LEVEL must be debug|info|warn|error, got "${logLevel}"`);
  }

  return {
    port: num('PORT', 8787, { min: 0, max: 65535 }),
    host: str('HOST', '0.0.0.0'),
    env: str('NODE_ENV', 'development'),
    dbPath: str('PITVISION_DB', 'data/pitvision.db'),
    apiToken: str('PITVISION_API_TOKEN', ''),
    anthropicKey: str('ANTHROPIC_API_KEY', ''),
    model: str('PITVISION_MODEL', 'claude-opus-5'),
    verifyTimeoutMs: num('PITVISION_VERIFY_TIMEOUT_MS', 20_000, { min: 1000, max: 120_000 }),
    verifyRetries: num('PITVISION_VERIFY_RETRIES', 1, { min: 0, max: 5 }),
    verifyRateLimit: num('PITVISION_VERIFY_RPM', 30, { min: 1, max: 10_000 }),
    ingestRateLimit: num('PITVISION_INGEST_RPM', 600, { min: 1, max: 100_000 }),
    retentionDays: num('PITVISION_RETENTION_DAYS', 30, { min: 1, max: 3650 }),
    monitorTickMs: num('PITVISION_MONITOR_TICK_MS', 2000, { min: 250, max: 60_000 }),
    sessionIdleMs: num('PITVISION_SESSION_IDLE_MS', 300_000, { min: 10_000 }),
    segmenterUrl: str('PITVISION_SEGMENTER_URL', '').replace(/\/+$/, ''),
    logLevel: logLevel as Config['logLevel'],
    trustProxy: bool('PITVISION_TRUST_PROXY', false),
    monitor: {
      stallMs: num('PITVISION_STALL_MS', 6000, { min: 500 }),
      latencyBudgetMs: num('PITVISION_LATENCY_BUDGET_MS', 100, { min: 1 }),
      latencyBreachRatio: num('PITVISION_LATENCY_BREACH_RATIO', 0.05, { min: 0, max: 1 }),
      driftMinSamples: num('PITVISION_DRIFT_MIN_SAMPLES', 6, { min: 1 }),
      driftFloor: num('PITVISION_DRIFT_FLOOR', 0.5, { min: 0, max: 1 }),
      verifyFailStreak: num('PITVISION_VERIFY_FAIL_STREAK', 3, { min: 1 }),
      instabilityFlips: num('PITVISION_INSTABILITY_FLIPS', 6, { min: 2 }),
      instabilityWindowMs: num('PITVISION_INSTABILITY_WINDOW_MS', 30_000, { min: 1000 }),
      surgePerMin: num('PITVISION_SURGE_PER_MIN', 14, { min: 1 }),
      laneLostMs: num('PITVISION_LANE_LOST_MS', 5000, { min: 500 }),
    },
    pricing: {
      inputPerMTok: num('PITVISION_PRICE_INPUT_PER_MTOK', 5, { min: 0 }),
      outputPerMTok: num('PITVISION_PRICE_OUTPUT_PER_MTOK', 25, { min: 0 }),
    },
  };
}
