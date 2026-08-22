/**
 * Structured logging.
 *
 * One JSON object per line, so `npm start | jq` works and so a log shipper can
 * read it without a grammar. Human-readable text is available for local dev,
 * where a wall of JSON is worse than useless.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bound: Record<string, unknown>): Logger;
}

const COLOUR: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

/**
 * Errors do not survive JSON.stringify — `{}` is the classic unhelpful log
 * line. Unwrap them into something that actually carries the failure.
 */
function serialise(value: unknown): unknown {
  if (value instanceof Error) {
    const out: Record<string, unknown> = { message: value.message, name: value.name };
    if (value.stack) out.stack = value.stack.split('\n').slice(0, 6).join('\n');
    const status = (value as { status?: unknown }).status;
    if (status !== undefined) out.status = status;
    if (value.cause) out.cause = serialise(value.cause);
    return out;
  }
  return value;
}

export function createLogger(level: Level, pretty: boolean): Logger {
  const min = ORDER[level];

  function make(bound: Record<string, unknown>): Logger {
    const emit = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
      if (ORDER[lvl] < min) return;
      const merged: Record<string, unknown> = { ...bound };
      if (fields) for (const [k, v] of Object.entries(fields)) merged[k] = serialise(v);

      if (pretty) {
        const rest = Object.entries(merged)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' ');
        const line = `${COLOUR[lvl]}${lvl.toUpperCase().padEnd(5)}\x1b[0m ${msg}${rest ? '  \x1b[90m' + rest + '\x1b[0m' : ''}`;
        (lvl === 'error' || lvl === 'warn' ? console.error : console.log)(line);
        return;
      }

      const record = JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...merged });
      (lvl === 'error' || lvl === 'warn' ? console.error : console.log)(record);
    };

    return {
      debug: (m, f) => emit('debug', m, f),
      info: (m, f) => emit('info', m, f),
      warn: (m, f) => emit('warn', m, f),
      error: (m, f) => emit('error', m, f),
      child: (extra) => make({ ...bound, ...extra }),
    };
  }

  return make({});
}
