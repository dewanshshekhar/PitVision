import type { FrameMetrics, Reading, Signals } from '../types';
import { slope } from '../util/math';
import { normaliseSignals, wetnessIndex, type Calibration } from './calibration';
import { ConditionClassifier } from './classify';
import { analyseFrame, toSignals } from './metrics';

/** Anything that can be drawn into a canvas: a <video> or the synthetic scene. */
export interface FrameSource {
  readonly drawable: CanvasImageSource | null;
  readonly width: number;
  readonly height: number;
  readonly ready: boolean;
  /**
   * Ask to be called when the next frame is actually presented, returning a
   * cancel function. Sources that can offer this (anything backed by a <video>,
   * via requestVideoFrameCallback) let the engine analyse a frame the moment it
   * arrives instead of discovering it on the next poll — which removes the
   * single largest term in end-to-end latency.
   */
  onNextFrame?(cb: (presentedAt: number) => void): (() => void) | undefined;
}

export interface EngineOptions {
  /** Width the frame is downscaled to before analysis. 384 keeps a full pass well under 10ms. */
  sampleWidth?: number;
  /** Target analysis rate. Above ~15Hz the extra samples tell you nothing new about weather. */
  hz?: number;
}

const TREND_WINDOW_MS = 8000;
const HISTORY_MS = 180_000;
/**
 * How long to wait for a frame callback before analysing anyway. Must sit
 * comfortably above a realistic frame interval, or it races the callback on
 * low-frame-rate footage and does the work twice.
 */
const WATCHDOG_MS = 400;

/**
 * Floor on the gap between analyses, which caps CPU. Chosen so the *staleness*
 * of the displayed result — worst case one gap plus one pass — stays well
 * inside the 100 ms budget, without analysing every frame of a 60 fps feed.
 */
const MIN_GAP_MS = 40;

export class CvEngine {
  private sampleW: number;
  private sampleH = 0;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private interval: number;
  private timer = 0;
  private running = false;
  private cancelFrame: (() => void) | null = null;
  private lastTickAt = 0;
  /** Rolling end-to-end latency: frame presented → result committed. */
  avgEndToEndMs = 0;
  private latencySamples: number[] = [];
  /** Called immediately before each analysis pass — used to advance a generated feed. */
  beforeTick: (() => void) | null = null;

  private ema: { road?: number; line?: number; edge?: number } = {};
  private classifier: ConditionClassifier;

  private trendT: number[] = [];
  private trendY: number[] = [];

  readonly history: Reading[] = [];
  lastMetrics: FrameMetrics | null = null;
  lastReading: Reading | null = null;
  /** Rolling average of the analysis cost — the number shown on the latency badge. */
  avgMs = 0;

  private listeners = new Set<(r: Reading, m: FrameMetrics) => void>();

  constructor(
    private source: FrameSource,
    private cal: Calibration,
    opts: EngineOptions = {},
  ) {
    this.sampleW = opts.sampleWidth ?? 384;
    this.interval = 1000 / (opts.hz ?? 12);
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.classifier = new ConditionClassifier(cal);
  }

  get sampleWidth() {
    return this.sampleW;
  }

  get sampleHeight() {
    return this.sampleH;
  }

  setSource(s: FrameSource) {
    this.source = s;
    this.resetSmoothing();
  }

  setCalibration(c: Calibration) {
    this.cal = c;
    this.classifier.setCalibration(c);
  }

  onReading(fn: (r: Reading, m: FrameMetrics) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  resetSmoothing() {
    this.ema = {};
    this.trendT = [];
    this.trendY = [];
    this.classifier.reset();
  }

  clearHistory() {
    this.history.length = 0;
    this.resetSmoothing();
  }

  /**
   * Analysis is driven by frame arrival where the source can report it, and by
   * a timer where it cannot (a generated canvas, or a browser without
   * requestVideoFrameCallback).
   *
   * The distinction matters for latency, not throughput. Polling at 12 Hz means
   * a frame that lands just after a tick waits up to 83 ms before anyone looks
   * at it, and that wait dominated the end-to-end figure — it was larger than
   * all the actual work combined. Reacting to presentation removes it.
   */
  start() {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop() {
    this.running = false;
    window.clearTimeout(this.timer);
    this.cancelFrame?.();
    this.cancelFrame = null;
  }

  private schedule() {
    if (!this.running) return;
    const src = this.source;
    let fired = false;

    const run = (presentedAt?: number, queueing = 0, countLatency = true) => {
      if (fired) return;
      fired = true;
      this.cancelFrame?.();
      this.cancelFrame = null;
      window.clearTimeout(this.timer);

      // Cap the analysis rate. Skipping a frame costs staleness, not latency:
      // whichever frame we do analyse is still turned around in one pass.
      const gap = Math.max(MIN_GAP_MS, this.avgMs * 1.4);
      if (performance.now() - this.lastTickAt >= gap) {
        this.beforeTick?.();
        this.tick(presentedAt, queueing, countLatency);
      }
      this.schedule();
    };

    const cancel = src.onNextFrame?.((presentedAt) => run(presentedAt));
    this.cancelFrame = cancel ?? null;

    // Watchdog. A paused, stalled or buffering feed produces no frame
    // callbacks at all, and without this the readout would simply stop —
    // which looks identical to a crash. It also keeps a still frame's
    // analysis current while someone is scrubbing or aiming the ROI.
    //
    // A watchdog tick on a frame-capable source is re-reading a still that has
    // been sitting there — it says nothing about how fast the pipeline turns a
    // frame around, so it is excluded from the latency statistic. On a source
    // that has no frame callback at all, the timer *is* the normal path and its
    // wait is counted honestly.
    const delay = cancel ? WATCHDOG_MS : this.interval;
    this.timer = window.setTimeout(() => run(undefined, delay / 2, !cancel), delay);
  }

  /** Run exactly one analysis pass. Used by tests and by the calibration panel. */
  step() {
    this.beforeTick?.();
    this.tick();
  }

  /**
   * Analyse the current frame and return the raw metrics *without* touching
   * smoothing, history or the classifier. Auto-calibration seeks around a clip
   * measuring frames; it must not leave a trail of bogus readings behind it.
   */
  probe(): FrameMetrics | null {
    return this.measure();
  }

  /** Current frame as a JPEG data URL, for the AI verification call. */
  snapshot(maxWidth = 768, quality = 0.72): string | null {
    const src = this.source;
    if (!src.ready || !src.drawable || !src.width) return null;
    const scale = Math.min(1, maxWidth / src.width);
    const w = Math.max(2, Math.round(src.width * scale));
    const h = Math.max(2, Math.round(src.height * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const cx = c.getContext('2d');
    if (!cx) return null;
    cx.drawImage(src.drawable, 0, 0, w, h);
    return c.toDataURL('image/jpeg', quality);
  }

  private smooth(key: 'road' | 'line' | 'edge', value: number): number {
    const a = this.cal.smoothing;
    const prev = this.ema[key];
    const next = prev === undefined ? value : prev + a * (value - prev);
    this.ema[key] = next;
    return next;
  }

  /**
   * Draw the current frame into the sampling canvas and run one analysis pass.
   *
   * The reported cost covers the whole path — frame upload, pixel readback and
   * the analysis itself — not just the maths. Timing only the arithmetic would
   * flatter the number by roughly an order of magnitude on a video source,
   * where decoding the frame is the expensive part.
   */
  private measure(): FrameMetrics | null {
    const t0 = performance.now();
    const src = this.source;
    if (!src.ready || !src.drawable || !src.width || !src.height) return null;

    // Assigning width/height resets the canvas, so only do it on a real change.
    const ratioH = Math.max(2, Math.round((src.height / src.width) * this.sampleW));
    if (this.canvas.width !== this.sampleW) this.canvas.width = this.sampleW;
    if (this.canvas.height !== ratioH) {
      this.canvas.height = ratioH;
      this.sampleH = ratioH;
    }

    try {
      this.ctx.drawImage(src.drawable, 0, 0, this.sampleW, this.sampleH);
    } catch {
      return null; // frame not decodable yet
    }
    const img = this.ctx.getImageData(0, 0, this.sampleW, this.sampleH);
    const metrics = analyseFrame(img, this.cal.road, { v: this.cal.glareV, s: this.cal.glareS });
    metrics.ms = performance.now() - t0;
    return metrics;
  }

  /** 95th-percentile end-to-end latency over the recent window. */
  get p95EndToEndMs(): number {
    if (this.latencySamples.length < 5) return this.avgEndToEndMs;
    const sorted = [...this.latencySamples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  }

  private tick(presentedAt?: number, queueing = 0, countLatency = true) {
    this.lastTickAt = performance.now();
    const metrics = this.measure();
    if (!metrics) return;

    // End to end means from the frame being presented to the result existing.
    // Without a presentation timestamp the honest fallback is the processing
    // cost plus the average wait for whichever scheduler produced this tick.
    const endToEnd =
      presentedAt !== undefined
        ? Math.max(metrics.ms, performance.now() - presentedAt)
        : metrics.ms + queueing;
    if (countLatency) {
      this.avgEndToEndMs = this.avgEndToEndMs === 0 ? endToEnd : this.avgEndToEndMs * 0.85 + endToEnd * 0.15;
      this.latencySamples.push(endToEnd);
      if (this.latencySamples.length > 120) this.latencySamples.shift();
    }

    this.lastMetrics = metrics;
    this.avgMs = this.avgMs === 0 ? metrics.ms : this.avgMs * 0.85 + metrics.ms * 0.15;

    const roadSignals: Signals = toSignals(metrics.road);
    const rawIndex = wetnessIndex(roadSignals, this.cal);
    const lineIndex = wetnessIndex(toSignals(metrics.line), this.cal);

    // The two edge bands are averaged by pixel count so a lopsided ROI doesn't
    // let the larger side dominate the divergence signal.
    const lw = metrics.left.pixels;
    const rw = metrics.right.pixels;
    const edgeIndexRaw =
      lw + rw === 0
        ? rawIndex
        : (wetnessIndex(toSignals(metrics.left), this.cal) * lw +
            wetnessIndex(toSignals(metrics.right), this.cal) * rw) /
          (lw + rw);

    const wetness = this.smooth('road', rawIndex);
    const line = this.smooth('line', lineIndex);
    const edge = this.smooth('edge', edgeIndexRaw);

    const now = performance.now();
    this.trendT.push(now);
    this.trendY.push(wetness);
    while (this.trendT.length > 2 && now - this.trendT[0] > TREND_WINDOW_MS) {
      this.trendT.shift();
      this.trendY.shift();
    }
    const trend = slope(this.trendT, this.trendY) * 60; // index units per minute

    const condition = this.classifier.update({
      wetness,
      line,
      edge,
      trend,
      luma: metrics.road.luma,
      glare: metrics.road.glare,
    });

    const reading: Reading = {
      t: Date.now(),
      wetness,
      wetnessRaw: rawIndex,
      line,
      edge,
      divergence: edge - line,
      condition,
      trend,
      signals: roadSignals,
      normalised: normaliseSignals(roadSignals, this.cal),
      ms: metrics.ms,
      ...(countLatency ? { endToEndMs: endToEnd } : {}),
    };

    this.lastReading = reading;
    this.history.push(reading);
    while (this.history.length > 1 && reading.t - this.history[0].t > HISTORY_MS) {
      this.history.shift();
    }

    for (const fn of this.listeners) fn(reading, metrics);
  }
}
