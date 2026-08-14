import type { Reading } from '../types';
import type { Calibration } from '../cv/calibration';
import { fitCanvas } from '../util/dom';

const WINDOW_MS = 120_000;

/**
 * Rolling wetness chart. Plots the fused road index as a filled area with the
 * racing-line and edge indices overlaid as thin traces — when those two
 * separate, you are watching a dry line form in real time.
 */
export class TrendChart {
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  draw(history: Reading[], cal: Calibration, accent: string) {
    const { w, h } = fitCanvas(this.canvas);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    const padL = 30;
    const padR = 6;
    const padT = 8;
    const padB = 16;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const yFor = (v: number) => padT + plotH * (1 - v / 100);

    // Condition bands
    const bands: [number, number, string][] = [
      [0, cal.dampAt, 'rgba(255,176,32,0.05)'],
      [cal.dampAt, cal.wetAt, 'rgba(56,189,248,0.05)'],
      [cal.wetAt, 100, 'rgba(79,124,255,0.06)'],
    ];
    for (const [a, b, fill] of bands) {
      ctx.fillStyle = fill;
      ctx.fillRect(padL, yFor(b), plotW, yFor(a) - yFor(b));
    }

    // Grid + axis
    ctx.strokeStyle = 'rgba(43,52,65,0.85)';
    ctx.fillStyle = '#5f6b7c';
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.lineWidth = 1;
    for (const v of [0, 25, 50, 75, 100]) {
      const y = Math.round(yFor(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.fillText(String(v), padL - 6, y + 3);
    }

    // Threshold markers
    for (const [v, colour, label] of [
      [cal.dampAt, 'rgba(56,189,248,0.5)', 'damp'],
      [cal.wetAt, 'rgba(79,124,255,0.55)', 'wet'],
    ] as [number, string, string][]) {
      const y = Math.round(yFor(v)) + 0.5;
      ctx.strokeStyle = colour;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = colour;
      ctx.textAlign = 'left';
      ctx.fillText(label, padL + 4, y - 3);
      ctx.textAlign = 'right';
    }

    if (history.length < 2) {
      ctx.fillStyle = '#5f6b7c';
      ctx.textAlign = 'center';
      ctx.font = '11px ui-sans-serif, system-ui';
      ctx.fillText('collecting samples…', padL + plotW / 2, padT + plotH / 2);
      return;
    }

    const now = history[history.length - 1].t;
    const t0 = now - WINDOW_MS;
    const visible = history.filter((r) => r.t >= t0);
    if (visible.length < 2) return;

    const xFor = (t: number) => padL + plotW * ((t - t0) / WINDOW_MS);

    // Road index — filled area
    ctx.beginPath();
    ctx.moveTo(xFor(visible[0].t), yFor(0));
    for (const r of visible) ctx.lineTo(xFor(r.t), yFor(r.wetness));
    ctx.lineTo(xFor(visible[visible.length - 1].t), yFor(0));
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, hexA(accent, 0.34));
    grad.addColorStop(1, hexA(accent, 0.02));
    ctx.fillStyle = grad;
    ctx.fill();

    this.trace(visible, xFor, yFor, (r) => r.wetness, accent, 2);
    this.trace(visible, xFor, yFor, (r) => r.line, 'rgba(70,224,138,0.9)', 1.2);
    this.trace(visible, xFor, yFor, (r) => r.edge, 'rgba(56,189,248,0.9)', 1.2);

    // Leading marker
    const last = visible[visible.length - 1];
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(xFor(last.t), yFor(last.wetness), 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#5f6b7c';
    ctx.textAlign = 'left';
    ctx.fillText('-2 min', padL, h - 4);
    ctx.textAlign = 'right';
    ctx.fillText('now', w - padR, h - 4);
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
