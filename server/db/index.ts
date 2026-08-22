/**
 * The database.
 *
 * `node:sqlite` ships with Node 22, so the telemetry store adds no dependency,
 * no native build and no service to run. A pit wall is a laptop in a garage
 * with unreliable networking; a single file that survives a power cut is worth
 * more here than anything that needs a connection string.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Logger } from '../lib/log.ts';

const here = dirname(fileURLToPath(import.meta.url));

export type Row = Record<string, unknown>;

export interface Db {
  raw: DatabaseSync;
  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number };
  all<T = Row>(sql: string, ...params: unknown[]): T[];
  get<T = Row>(sql: string, ...params: unknown[]): T | undefined;
  tx<T>(fn: () => T): T;
  close(): void;
}

export function openDb(path: string, log: Logger): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const raw = new DatabaseSync(path);

  // WAL lets the monitor sweep read while ingest writes, which is the whole
  // concurrency story here. NORMAL synchronous is the standard WAL pairing:
  // a crash can lose the last transaction, not the database.
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA synchronous = NORMAL');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA busy_timeout = 5000');

  raw.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));

  // Prepared statements are cached: ingest re-runs the same handful of inserts
  // thousands of times per session and re-preparing each one is pure overhead.
  const cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  const prep = (sql: string) => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };

  let txDepth = 0;

  const db: Db = {
    raw,
    run(sql, ...params) {
      const r = prep(sql).run(...(params as never[]));
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    all<T>(sql: string, ...params: unknown[]) {
      return prep(sql).all(...(params as never[])) as T[];
    },
    get<T>(sql: string, ...params: unknown[]) {
      return prep(sql).get(...(params as never[])) as T | undefined;
    },
    /**
     * Nested calls join the outer transaction rather than opening a second
     * one — SQLite has no nested BEGIN, and the alternative is an error at the
     * one moment you least want one.
     */
    tx<T>(fn: () => T): T {
      if (txDepth > 0) return fn();
      raw.exec('BEGIN IMMEDIATE');
      txDepth++;
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        try {
          raw.exec('ROLLBACK');
        } catch {
          /* the failure that matters is the original one */
        }
        throw err;
      } finally {
        txDepth--;
      }
    },
    close() {
      try {
        raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        /* best effort on the way out */
      }
      cache.clear();
      raw.close();
    },
  };

  log.info('database ready', { path, tables: countTables(db) });
  return db;
}

function countTables(db: Db): number {
  const row = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'",
  );
  return row?.n ?? 0;
}

/**
 * Drop old telemetry. Readings dominate the file — a two-hour session at 1 Hz
 * is ~7000 rows — while events, verifications and incidents are the audit
 * trail and are kept for the life of the session record.
 */
export function pruneOldData(db: Db, retentionDays: number, log: Logger): number {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const removed = db.tx(() => {
    const r = db.run('DELETE FROM readings WHERE t < ?', cutoff);
    db.run(
      "DELETE FROM sessions WHERE status != 'active' AND COALESCE(ended_at, last_seen_at) < ?",
      cutoff,
    );
    return r.changes;
  });
  if (removed > 0) log.info('pruned old readings', { removed, retentionDays });
  return removed;
}
