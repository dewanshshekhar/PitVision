import type { LaneTrace } from './lane';
import { ROWS } from './lane';

/**
 * Client for the road-segmentation sidecar.
 *
 * The sidecar runs a network trained on real driving footage, which finds the
 * road far more reliably than a hand-written heuristic can — through spray, at
 * night, across patched and rubbered-in tarmac. What it cannot do is run on
 * every frame: a CPU inference is tens of milliseconds against a 100 ms
 * end-to-end budget.
 *
 * So it is used exactly as the geometric tracer is: asked a few times a second,
 * reused in between. A road does not move between two frames 40 ms apart. The
 * wetness readout still updates every frame; only the shape it is measured
 * through holds still between calls.
 *
 * Everything here is optional and every failure is silent. Most installations
 * will never run a sidecar, and for them this class does nothing at all — the
 * geometric tracer is underneath it, and a hand-placed ROI underneath that.
 * A road detector that stops working when a Python process is not running would
 * be a worse detector than the one it replaced.
 */

/** How often the sidecar is asked. Deliberately slower than the geometric tracer. */
const INTERVAL_MS = 400;

/** After this many consecutive failures, stop asking until something changes. */
const GIVE_UP_AFTER = 4;

export type SegState = 'off' | 'probing' | 'live' | 'no-road' | 'unavailable';

export interface SegStatus {
  state: SegState;
  /** Round trip including inference, milliseconds. */
  latencyMs: number;
  /** What the sidecar reported about the track limits. */
  limitsFrom: string | null;
  message: string;
}

interface WireCorridor {
  yTop: number;
  yBot: number;
  left: number[];
  right: number[];
  confidence: number;
  measuredRows: number;
  meanWidth: number;
  limitsFrom?: string;
}

export class SegmentationClient {
  private inFlight = false;
  private lastAt = 0;
  private failures = 0;
  private current: LaneTrace | null = null;
  private status: SegStatus = {
    state: 'off',
    latencyMs: 0,
    limitsFrom: null,
    message: 'Not started',
  };

  /** Turned on only once the sidecar has answered at least once. */
  enabled = false;

  get trace(): LaneTrace | null {
    return this.current;
  }

  get state(): SegStatus {
    return this.status;
  }

  reset() {
    this.current = null;
    this.failures = 0;
    this.lastAt = 0;
    this.status = { state: this.enabled ? 'probing' : 'off', latencyMs: 0, limitsFrom: null, message: 'Reset' };
  }

  /**
   * Ask once whether a sidecar is there.
   *
   * Called from the pre-race check rather than on a timer: whether a model is
   * installed is a property of the deployment, not something that changes
   * during a session, and probing for it repeatedly would log a failure every
   * few seconds on the majority of installs that will never have one.
   */
  async probe(): Promise<boolean> {
    try {
      const res = await fetch('/api/segment/health');
      const body = (await res.json()) as { configured?: boolean; ok?: boolean; upstream?: { model?: string } };
      if (!body.configured) {
        this.enabled = false;
        this.status = { state: 'off', latencyMs: 0, limitsFrom: null, message: 'No segmenter configured' };
        return false;
      }
      if (!body.ok) {
        this.enabled = false;
        this.status = { state: 'unavailable', latencyMs: 0, limitsFrom: null, message: 'Segmenter configured but not responding' };
        return false;
      }
      this.enabled = true;
      this.failures = 0;
      this.status = {
        state: 'probing',
        latencyMs: 0,
        limitsFrom: null,
        message: `Segmenter ready — ${body.upstream?.model ?? 'model'}`,
      };
      return true;
    } catch {
      this.enabled = false;
      this.status = { state: 'off', latencyMs: 0, limitsFrom: null, message: 'Backend unreachable' };
      return false;
    }
  }

  /**
   * Offer a frame. Returns immediately with whatever corridor is current.
   *
   * Fire and forget: the request is not awaited, so this never blocks the
   * analysis pass. The corridor it returns is the one from the *previous*
   * successful call, which is the whole design — a corridor a few hundred
   * milliseconds old still describes the road.
   */
  update(snapshot: () => string | null, now = performance.now()): LaneTrace | null {
    if (!this.enabled || this.inFlight) return this.current;
    if (now - this.lastAt < INTERVAL_MS) return this.current;
    this.lastAt = now;

    const image = snapshot();
    if (!image) return this.current;

    void this.request(image);
    return this.current;
  }

  private async request(image: string) {
    this.inFlight = true;
    const started = performance.now();
    try {
      const res = await fetch('/api/segment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image }),
      });
      const body = (await res.json()) as { corridor?: WireCorridor | null; reason?: string };
      const latencyMs = Math.round(performance.now() - started);

      if (!body.corridor) {
        this.failures++;
        // A refusal is not a failure of the sidecar — it is the sidecar saying
        // there is no road in this frame, which is a real answer. Only drop the
        // corridor once several frames in a row have said so, or a single
        // frame of spray would blank the region.
        if (this.failures >= GIVE_UP_AFTER) this.current = null;
        this.status = {
          state: body.reason?.includes('unreachable') || body.reason?.includes('no segmenter')
            ? 'unavailable'
            : 'no-road',
          latencyMs,
          limitsFrom: null,
          message: body.reason ?? 'No road found',
        };
        return;
      }

      this.failures = 0;
      this.current = toTrace(body.corridor);
      this.status = {
        state: 'live',
        latencyMs,
        limitsFrom: body.corridor.limitsFrom ?? null,
        message:
          `Road segmented — ${(body.corridor.confidence * 100).toFixed(0)}% of rows, ` +
          `limits from ${body.corridor.limitsFrom ?? 'mask edge'}`,
      };
    } catch {
      this.failures++;
      if (this.failures >= GIVE_UP_AFTER) {
        this.current = null;
        this.enabled = false;
        this.status = { state: 'unavailable', latencyMs: 0, limitsFrom: null, message: 'Segmenter stopped responding' };
      }
    } finally {
      this.inFlight = false;
    }
  }
}

/**
 * Convert the wire shape into the `LaneTrace` the rest of the pipeline uses.
 *
 * Both sides already agree on the row count and on normalised coordinates, so
 * this is a copy rather than a conversion — which is the point of having the
 * Python side emit exactly this shape. A resampling step here would be a place
 * for the two road sources to quietly disagree about where the road is.
 */
function toTrace(c: WireCorridor): LaneTrace | null {
  if (!Array.isArray(c.left) || c.left.length !== ROWS || c.right.length !== ROWS) return null;
  return {
    yTop: c.yTop,
    yBot: c.yBot,
    left: Float32Array.from(c.left),
    right: Float32Array.from(c.right),
    confidence: c.confidence,
    measuredRows: c.measuredRows,
    meanWidth: c.meanWidth,
    // The sidecar measures these from the mask, not from the pixels the browser
    // will sample, so they are left unset rather than filled with a number from
    // a different measurement. Nothing downstream reads them for a traced lane.
    surfaceSat: 0,
    surfaceLuma: 0,
    at: performance.now(),
  };
}
