/**
 * HTTP plumbing: typed errors, async route wrapping, and input validation.
 *
 * The validators are hand-rolled and deliberately small. Telemetry ingest is
 * the hottest path in the server and runs on every batch, so validation has to
 * be cheap; the shapes involved are a dozen numbers, not a document.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new HttpError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Missing or invalid API token.') =>
  new HttpError(401, 'unauthorized', msg);
export const notFound = (msg: string) => new HttpError(404, 'not_found', msg);
export const conflict = (msg: string) => new HttpError(409, 'conflict', msg);
export const tooMany = (msg: string, retryAfterSec: number) =>
  new HttpError(429, 'rate_limited', msg, { retryAfterSec });
export const unavailable = (msg: string) => new HttpError(503, 'unavailable', msg);

/** Express 5 forwards rejected promises, but only if the handler returns one. */
export function route(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
): RequestHandler {
  return (req, res, next) => {
    try {
      const out = fn(req, res, next);
      if (out instanceof Promise) out.catch(next);
    } catch (err) {
      next(err);
    }
  };
}

// ── Validation ─────────────────────────────────────────────────────────

export class Field {
  // Named `data`, not `obj`: this class also exposes an `obj()` accessor, and a
  // class field of the same name shadows the prototype method at runtime.
  private readonly data: Record<string, unknown>;
  private readonly path: string;

  constructor(data: Record<string, unknown>, path: string) {
    this.data = data;
    this.path = path;
  }

  private raw(key: string): unknown {
    return this.data?.[key];
  }

  private where(key: string): string {
    return this.path ? `${this.path}.${key}` : key;
  }

  str(key: string, opts: { max?: number; optional?: boolean; enum?: readonly string[] } = {}): string {
    const v = this.raw(key);
    if (v === undefined || v === null || v === '') {
      if (opts.optional) return '';
      throw badRequest(`\`${this.where(key)}\` is required.`);
    }
    if (typeof v !== 'string') throw badRequest(`\`${this.where(key)}\` must be a string.`);
    if (opts.max && v.length > opts.max) {
      throw badRequest(`\`${this.where(key)}\` must be at most ${opts.max} characters.`);
    }
    if (opts.enum && !opts.enum.includes(v)) {
      throw badRequest(`\`${this.where(key)}\` must be one of: ${opts.enum.join(', ')}.`);
    }
    return v;
  }

  num(key: string, opts: { min?: number; max?: number; default?: number } = {}): number {
    const v = this.raw(key);
    if (v === undefined || v === null) {
      if (opts.default !== undefined) return opts.default;
      throw badRequest(`\`${this.where(key)}\` is required.`);
    }
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) throw badRequest(`\`${this.where(key)}\` must be a finite number.`);
    if (opts.min !== undefined && n < opts.min) {
      throw badRequest(`\`${this.where(key)}\` must be >= ${opts.min}.`);
    }
    if (opts.max !== undefined && n > opts.max) {
      throw badRequest(`\`${this.where(key)}\` must be <= ${opts.max}.`);
    }
    return n;
  }

  bool(key: string, fallback = false): boolean {
    const v = this.raw(key);
    if (v === undefined || v === null) return fallback;
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === '1' || v === 1) return true;
    if (v === 'false' || v === '0' || v === 0) return false;
    throw badRequest(`\`${this.where(key)}\` must be a boolean.`);
  }

  obj(key: string, { optional = false } = {}): Field | null {
    const v = this.raw(key);
    if (v === undefined || v === null) {
      if (optional) return null;
      throw badRequest(`\`${this.where(key)}\` is required.`);
    }
    if (typeof v !== 'object' || Array.isArray(v)) {
      throw badRequest(`\`${this.where(key)}\` must be an object.`);
    }
    return new Field(v as Record<string, unknown>, this.where(key));
  }

  arr(key: string, { max = 10_000, optional = false } = {}): Field[] {
    const v = this.raw(key);
    if (v === undefined || v === null) {
      if (optional) return [];
      throw badRequest(`\`${this.where(key)}\` is required.`);
    }
    if (!Array.isArray(v)) throw badRequest(`\`${this.where(key)}\` must be an array.`);
    if (v.length > max) {
      throw badRequest(`\`${this.where(key)}\` may hold at most ${max} items, got ${v.length}.`);
    }
    return v.map((item, i) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw badRequest(`\`${this.where(key)}[${i}]\` must be an object.`);
      }
      return new Field(item as Record<string, unknown>, `${this.where(key)}[${i}]`);
    });
  }

  /** Free-form blob stored as JSON. Bounded so a client cannot post a novel. */
  json(key: string, maxChars = 64_000): string | null {
    const v = this.raw(key);
    if (v === undefined || v === null) return null;
    const text = JSON.stringify(v);
    if (text.length > maxChars) {
      throw badRequest(`\`${this.where(key)}\` is too large (${text.length} > ${maxChars} chars).`);
    }
    return text;
  }
}

/**
 * A path parameter as a plain string.
 *
 * Express 5 types these as `string | string[]` because a repeated pattern can
 * capture more than once. None of these routes do, but a client can still send
 * something that lands in the array branch, and silently stringifying an array
 * would turn a malformed request into a lookup for a session id that reads
 * `a,b`. It is rejected instead.
 */
export function param(req: Request, name: string): string {
  const raw = (req.params as Record<string, string | string[] | undefined>)[name];
  if (typeof raw === 'string') return raw;
  throw badRequest(`\`${name}\` must appear exactly once in the path.`);
}

export function body(req: Request): Field {
  const b = req.body;
  if (typeof b !== 'object' || b === null || Array.isArray(b)) {
    throw badRequest('Request body must be a JSON object.');
  }
  return new Field(b as Record<string, unknown>, '');
}
