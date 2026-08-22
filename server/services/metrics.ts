/**
 * Process metrics, in Prometheus text format.
 *
 * Deliberately separate from the per-session monitoring. This answers "is the
 * server healthy" — request rates, error rates, how long the Anthropic call is
 * taking, how much it has cost. The monitor answers "is the detection healthy",
 * which is a different question with a different audience.
 */

interface Histogram {
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
}

function histogram(buckets: number[]): Histogram {
  return { buckets, counts: new Array(buckets.length + 1).fill(0), sum: 0, count: 0 };
}

function observe(h: Histogram, value: number) {
  h.sum += value;
  h.count++;
  let i = 0;
  while (i < h.buckets.length && value > h.buckets[i]) i++;
  h.counts[i]++;
}

/** Reconstruct a quantile from the bucket counts. Coarse, and honest about it. */
function quantile(h: Histogram, q: number): number {
  if (h.count === 0) return 0;
  const target = h.count * q;
  let seen = 0;
  for (let i = 0; i < h.counts.length; i++) {
    seen += h.counts[i];
    if (seen >= target) return i < h.buckets.length ? h.buckets[i] : Infinity;
  }
  return Infinity;
}

export class Metrics {
  readonly startedAt = Date.now();

  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();

  private httpDuration = histogram([5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]);
  private verifyDuration = histogram([250, 500, 1000, 2000, 3000, 5000, 8000, 13000, 21000]);
  private ingestBatch = histogram([1, 5, 10, 25, 50, 100, 250, 500]);

  inc(name: string, by = 1, labels?: Record<string, string>) {
    const key = labels ? `${name}|${serialiseLabels(labels)}` : name;
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  set(name: string, value: number) {
    this.gauges.set(name, value);
  }

  observeHttp(ms: number) {
    observe(this.httpDuration, ms);
  }

  observeVerify(ms: number) {
    observe(this.verifyDuration, ms);
  }

  observeIngest(rows: number) {
    observe(this.ingestBatch, rows);
  }

  get verifyP95() {
    return quantile(this.verifyDuration, 0.95);
  }

  snapshot() {
    return {
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      http: { count: this.httpDuration.count, p50: quantile(this.httpDuration, 0.5), p95: quantile(this.httpDuration, 0.95) },
      verify: { count: this.verifyDuration.count, p50: quantile(this.verifyDuration, 0.5), p95: quantile(this.verifyDuration, 0.95) },
    };
  }

  /** Prometheus exposition format. */
  render(): string {
    const out: string[] = [];
    const mem = process.memoryUsage();

    out.push('# HELP pitvision_uptime_seconds Seconds since the server started.');
    out.push('# TYPE pitvision_uptime_seconds gauge');
    out.push(`pitvision_uptime_seconds ${Math.round((Date.now() - this.startedAt) / 1000)}`);

    out.push('# HELP pitvision_resident_memory_bytes Resident set size.');
    out.push('# TYPE pitvision_resident_memory_bytes gauge');
    out.push(`pitvision_resident_memory_bytes ${mem.rss}`);

    for (const [key, value] of this.counters) {
      const [name, labels] = key.split('|');
      out.push(`# TYPE ${name} counter`);
      out.push(`${name}${labels ? `{${labels}}` : ''} ${value}`);
    }
    for (const [name, value] of this.gauges) {
      out.push(`# TYPE ${name} gauge`);
      out.push(`${name} ${value}`);
    }

    out.push(...renderHistogram('pitvision_http_request_duration_ms', this.httpDuration));
    out.push(...renderHistogram('pitvision_verify_duration_ms', this.verifyDuration));
    out.push(...renderHistogram('pitvision_ingest_batch_rows', this.ingestBatch));

    return out.join('\n') + '\n';
  }
}

function serialiseLabels(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '_')}"`)
    .join(',');
}

function renderHistogram(name: string, h: Histogram): string[] {
  const out = [`# TYPE ${name} histogram`];
  let cumulative = 0;
  for (let i = 0; i < h.buckets.length; i++) {
    cumulative += h.counts[i];
    out.push(`${name}_bucket{le="${h.buckets[i]}"} ${cumulative}`);
  }
  cumulative += h.counts[h.counts.length - 1];
  out.push(`${name}_bucket{le="+Inf"} ${cumulative}`);
  out.push(`${name}_sum ${h.sum}`);
  out.push(`${name}_count ${h.count}`);
  return out;
}
