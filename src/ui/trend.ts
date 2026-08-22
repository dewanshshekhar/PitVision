import type { Reading } from '../types';
import type { Calibration } from '../cv/calibration';
import { fitCanvas } from '../util/dom';

const WINDOW_MS = 120_000;

/**
 * Rolling wetness chart matching the Desktop - 12 specification.
 */
export class TrendChart {
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  draw(history: Reading[], _cal: Calibration, accent: string) {
    const { w, h } = fitCanvas(this.canvas);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    const padL = 0;
    const padT = 0;
    const plotW = w;
    const plotH = h;

    const yFor = (v: number) => padT + plotH * (1 - Math.max(0, Math.min(100, v)) / 100);

    if (history.length < 2) {
      return;
    }

    const now = history[history.length - 1].t;
    const t0 = now - WINDOW_MS;
    const visible = history.filter((r) => r.t >= t0);
    if (visible.length < 2) return;

    const xFor = (t: number) => padL + plotW * ((t - t0) / WINDOW_MS);

    // Road index — filled gradient area
    ctx.beginPath();
    ctx.moveTo(xFor(visible[0].t), yFor(0));
    for (const r of visible) ctx.lineTo(xFor(r.t), yFor(r.wetness));
    ctx.lineTo(xFor(visible[visible.length - 1].t), yFor(0));
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, 0, 0, plotH);
    grad.addColorStop(0, hexA(accent, 0.35));
    grad.addColorStop(1, hexA(accent, 0.05));
    ctx.fillStyle = grad;
    ctx.fill();

    // Road Index line trace
    this.trace(visible, xFor, yFor, (r) => r.wetness, '#FFFFFF', 2);
    // Racing Line trace
    this.trace(visible, xFor, yFor, (r) => r.line, 'rgba(0, 229, 255, 0.8)', 1.5);
    // Track Edges trace
    this.trace(visible, xFor, yFor, (r) => r.edge, 'rgba(0, 255, 102, 0.7)', 1.5);

    // Leading marker
    const last = visible[visible.length - 1];
    ctx.fillStyle = '#FFFFFF';
    ctx.shadowColor = '#00E5FF';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(xFor(last.t), yFor(last.wetness), 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  private trace(
    rows: Reading[],
    xFor: (t: number) => number,
    yFor: (v: number) => number,
    pick: (r: Reading) => number,
    colour: string,
    width: number,
  ) {
    const ctx = this.ctx;
    ctx.beginPath();
    rows.forEach((r, i) => {
      const x = xFor(r.t);
      const y = yFor(pick(r));
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

function hexA(colour: string, alpha: number): string {
  if (colour.startsWith('#')) {
    const n = parseInt(colour.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  return colour;
}
