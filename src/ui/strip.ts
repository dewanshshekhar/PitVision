import type { Condition, Reading } from '../types';
import { fitCanvas } from '../util/dom';

export const CONDITION_COLOUR: Record<Condition, string> = {
  Sunny: '#ffd34d',
  Dry: '#ffb020',
  Greasy: '#c9d152',
  Drying: '#46e08a',
  Damp: '#38bdf8',
  Wet: '#4f7cff',
  Flooded: '#7b5cff',
};

const SPAN_MS = 180_000;

/**
 * A condition timeline: every sample rendered as a coloured column. It is the
 * fastest way to see that the read is *continuous* rather than a sequence of
 * discrete decisions — and it makes transitions impossible to miss.
 */
export class ConditionStrip {
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  draw(history: Reading[]) {
    const { w, h } = fitCanvas(this.canvas);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = '#12161d';
    ctx.fillRect(0, 0, w, h);

    if (history.length === 0) return;

    const now = history[history.length - 1].t;
    const t0 = now - SPAN_MS;

    for (let i = 0; i < history.length; i++) {
      const r = history[i];
      if (r.t < t0) continue;
      const next = history[i + 1];
      const x0 = ((r.t - t0) / SPAN_MS) * w;
      const x1 = next ? ((next.t - t0) / SPAN_MS) * w : x0 + w / 260;
      ctx.fillStyle = CONDITION_COLOUR[r.condition];
      ctx.globalAlpha = 0.35 + 0.65 * (r.wetness / 100);
      ctx.fillRect(x0, 0, Math.max(1.05, x1 - x0), h);
    }
    ctx.globalAlpha = 1;

    // Leading edge cursor
    ctx.fillStyle = 'rgba(238,242,247,0.9)';
    ctx.fillRect(w - 2, 0, 2, h);
  }
}
