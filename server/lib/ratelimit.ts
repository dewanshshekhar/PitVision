/**
 * Token-bucket rate limiter, per client key.
 *
 * `/api/verify` spends money on every call, so the limiter is not there to
 * shape traffic — it is there so a runaway client loop or an open port cannot
 * turn into an unbounded bill. Ingest gets a much larger bucket because a
 * stalled pit-wall client retrying its batches is a normal Tuesday.
 */

interface Bucket {
  tokens: number;
  updated: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;

  constructor(capacity: number, windowMs = 60_000) {
    this.capacity = capacity;
    this.refillPerMs = capacity / windowMs;
  }

  /** Returns null when allowed, or the seconds to wait when not. */
  check(key: string, now = Date.now()): number | null {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, updated: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.updated) * this.refillPerMs);
    b.updated = now;

    if (b.tokens < 1) {
      return Math.max(1, Math.ceil((1 - b.tokens) / this.refillPerMs / 1000));
    }
    b.tokens -= 1;
    return null;
  }

  /** Drop buckets that have refilled completely — they carry no state worth keeping. */
  sweep(now = Date.now()) {
    const full = this.capacity / this.refillPerMs;
    for (const [key, b] of this.buckets) {
      if (now - b.updated > full) this.buckets.delete(key);
    }
  }

  get size() {
    return this.buckets.size;
  }
}
