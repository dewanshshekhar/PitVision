import type { LaneTrace } from './lane';
import { ROWS, sampleAt } from './lane';

/**
 * Client for the road-segmentation sidecar.
 *
 * The sidecar runs a network trained on real driving footage, which finds the
 * road far more reliably than a hand-written heuristic can — through spray, at
 * night, across patched and rubbered-in tarmac. What it cannot do is run on
 * every frame: a CPU inference is tens of milliseconds against a 100 ms
 * end-to-end budget.
 *
 * The network supplies semantic keyframes while the geometric tracer carries
 * their motion between responses. This avoids both request pile-ups and the
 * visibly stale overlay produced by holding one mask through a fast turn.
 *
 * Everything here is optional and every failure is silent. Most installations
 * will never run a sidecar, and for them this class does nothing at all — the
 * geometric tracer is underneath it, and a hand-placed ROI underneath that.
 * A road detector that stops working when a Python process is not running would
 * be a worse detector than the one it replaced.
 */

/** Semantic keyframe cadence. In-flight gating prevents request pile-ups. */
export const SEGMENT_INTERVAL_MS = 120;

/** Never measure through a neural result captured before the current turn. */
export const MAX_SEGMENT_AGE_MS = 450;

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
  /** Browser trace from the exact frame sent for the current neural result. */
  private anchor: LaneTrace | null = null;
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
    this.anchor = null;
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
   * analysis pass. A previous semantic result is returned only after its
   * per-row motion has been updated from the current geometric trace.
   */
  update(
    snapshot: () => string | null,
    guide: LaneTrace | null = null,
    now = performance.now(),
  ): LaneTrace | null {
    const visible = this.visibleTrace(guide, now);
    if (!this.enabled || this.inFlight) return visible;
    if (now - this.lastAt < SEGMENT_INTERVAL_MS) return visible;

    const image = snapshot();
    if (!image) return visible;
    this.lastAt = now;

    void this.request(image, now, guide);
    return visible;
  }

  private visibleTrace(guide: LaneTrace | null, now: number): LaneTrace | null {
    if (!this.current || now - this.current.at > MAX_SEGMENT_AGE_MS) return null;
    if (!guide || !this.anchor) return this.current;
    return propagate(this.current, this.anchor, guide, now);
  }

  private async request(image: string, capturedAt: number, anchor: LaneTrace | null) {
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
        if (this.failures >= GIVE_UP_AFTER) {
          this.current = null;
          this.anchor = null;
        }
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
      this.current = toTrace(body.corridor, capturedAt);
      this.anchor = this.current ? anchor : null;
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
        this.anchor = null;
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
function toTrace(c: WireCorridor, capturedAt: number): LaneTrace | null {
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
    // This is when the image was captured, not when inference finished. Using
    // response time made a stale corridor look fresh during a fast turn.
    at: capturedAt,
  };
}

/**
 * Carry a semantic keyframe forward with the live geometric trace.
 *
 * RVLD-style video tracking recursively propagates lane state rather than
 * holding the last neural frame. We already have a cheap trace on every
 * analysed frame, so its per-row motion is the propagation signal: semantic
 * boundaries come from the network, current motion comes from the browser.
 */
function propagate(keyframe: LaneTrace, from: LaneTrace, to: LaneTrace, now: number): LaneTrace {
  const left = new Float32Array(ROWS);
  const right = new Float32Array(ROWS);
  let widthSum = 0;

  for (let i = 0; i < ROWS; i++) {
    const y = keyframe.yTop + ((keyframe.yBot - keyframe.yTop) * i) / (ROWS - 1);
    const [fromL, fromR] = sampleAt(from, y);
    const [toL, toR] = sampleAt(to, y);
    let l = Math.max(0, Math.min(1, keyframe.left[i] + Math.max(-0.2, Math.min(0.2, toL - fromL))));
    let r = Math.max(0, Math.min(1, keyframe.right[i] + Math.max(-0.2, Math.min(0.2, toR - fromR))));
    if (r < l) [l, r] = [r, l];
    left[i] = l;
    right[i] = r;
    widthSum += r - l;
  }

  return {
    ...keyframe,
    left,
    right,
    meanWidth: widthSum / ROWS,
    at: now,
  };
}
