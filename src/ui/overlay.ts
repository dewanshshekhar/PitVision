import type { FrameMetrics } from '../types';
import type { Calibration } from '../cv/calibration';
import { normalise } from '../util/math';
import { bandCorners, roadCorners, SUB_BANDS, type RoadGeometry } from '../cv/rois';
import { coverTransform, fitCanvas } from '../util/dom';

const BAND_STYLE: Record<string, { stroke: string; label: string }> = {
  line: { stroke: 'rgba(70,224,138,0.95)', label: 'RACING LINE' },
  left: { stroke: 'rgba(56,189,248,0.85)', label: 'EDGE L' },
  right: { stroke: 'rgba(56,189,248,0.85)', label: 'EDGE R' },
};

/**
 * Draws the ROI geometry and a wetness heatmap directly onto the feed.
 *
 * Two reasons this is not decoration: it makes the racing-line-versus-edge
 * comparison legible at a glance during a demo, and it is the fastest way to
 * spot a mis-placed ROI while calibrating against unfamiliar footage.
 */
type Corner = 0 | 1 | 2 | 3;

export class Overlay {
  private ctx: CanvasRenderingContext2D;
  private heatCanvas = document.createElement('canvas');
  private heatCtx: CanvasRenderingContext2D;
  private drag: Corner | null = null;
  private hover: Corner | null = null;
  private lastGeom: { ox: number; oy: number; sw: number; sh: number } | null = null;
  showRois = true;
  showHeat = true;
  editing = false;
  /** Called while a corner is dragged, with the updated road geometry. */
  onRoadChange: ((road: RoadGeometry) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.heatCtx = this.heatCanvas.getContext('2d')!;
  }

  /**
   * Corner dragging directly on the video. Aiming the ROI at unfamiliar footage
   * is the first thing anyone has to do and the easiest thing to get wrong;
   * six sliders is the wrong tool for a spatial job.
   */
  attachEditing(cal: () => Calibration) {
    const local = (e: PointerEvent) => {
      const r = this.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const nearest = (p: { x: number; y: number }): Corner | null => {
      const g = this.lastGeom;
      if (!g) return null;
      const pts = roadCorners(cal().road, 1, 1).map((c) => ({
        x: g.ox + c.x * g.sw,
        y: g.oy + c.y * g.sh,
      }));
      let best: Corner | null = null;
      let bestD = 22;
      pts.forEach((pt, i) => {
        const d = Math.hypot(pt.x - p.x, pt.y - p.y);
        if (d < bestD) {
          bestD = d;
          best = i as Corner;
        }
      });
      return best;
    };

    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.editing) return;
      const c = nearest(local(e));
      if (c === null) return;
      this.drag = c;
      this.canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.editing) return;
      const p = local(e);
      const g = this.lastGeom;
      if (this.drag === null) {
        this.hover = nearest(p);
        this.canvas.style.cursor = this.hover === null ? 'crosshair' : 'grab';
        return;
      }
      if (!g) return;
      const nx = Math.min(1, Math.max(0, (p.x - g.ox) / g.sw));
      const ny = Math.min(1, Math.max(0, (p.y - g.oy) / g.sh));
      const road = { ...cal().road };

      // Corner order is top-left, top-right, bottom-right, bottom-left. The two
      // corners on an edge share that edge's y, so dragging either moves both.
      if (this.drag === 0) { road.xTopL = nx; road.yTop = ny; }
      if (this.drag === 1) { road.xTopR = nx; road.yTop = ny; }
      if (this.drag === 2) { road.xBotR = nx; road.yBot = ny; }
      if (this.drag === 3) { road.xBotL = nx; road.yBot = ny; }
      road.yTop = Math.min(road.yTop, road.yBot - 0.05);
      road.yBot = Math.max(road.yBot, road.yTop + 0.05);
      this.onRoadChange?.(road);
    });

    const release = (e: PointerEvent) => {
      if (this.drag === null) return;
      this.drag = null;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };
    this.canvas.addEventListener('pointerup', release);
    this.canvas.addEventListener('pointercancel', release);
  }

  draw(metrics: FrameMetrics | null, cal: Calibration, srcW: number, srcH: number) {
    const { w, h } = fitCanvas(this.canvas);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    if (!metrics || !srcW || !srcH) return;

    const { ox, oy, sw, sh } = coverTransform(w, h, srcW, srcH);
    this.lastGeom = { ox, oy, sw, sh };
    const toX = (nx: number) => ox + nx * sw;
    const toY = (ny: number) => oy + ny * sh;

    if (this.showHeat) this.drawHeat(metrics, cal, ox, oy, sw, sh);
    if (this.showRois || this.editing) this.drawRois(cal, toX, toY);
    if (this.editing) this.drawHandles(cal, toX, toY);
  }

  private drawHandles(cal: Calibration, toX: (n: number) => number, toY: (n: number) => number) {
    const ctx = this.ctx;
    const pts = roadCorners(cal.road, 1, 1);
    pts.forEach((p, i) => {
      const x = toX(p.x);
      const y = toY(p.y);
      const active = this.drag === i || this.hover === i;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, active ? 10 : 7, 0, Math.PI * 2);
      ctx.fillStyle = active ? 'rgba(255,176,32,0.95)' : 'rgba(6,7,10,0.7)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,176,32,0.95)';
      ctx.stroke();
      ctx.restore();
    });
  }

  private drawHeat(
    m: FrameMetrics,
    cal: Calibration,
    ox: number,
    oy: number,
    sw: number,
    sh: number,
  ) {
    const { heatW, heatH, heatGlare, heatLuma } = m;
    if (this.heatCanvas.width !== heatW || this.heatCanvas.height !== heatH) {
      this.heatCanvas.width = heatW;
      this.heatCanvas.height = heatH;
    }
    const img = this.heatCtx.createImageData(heatW, heatH);
    const d = img.data;

    for (let i = 0; i < heatW * heatH; i++) {
      const g = heatGlare[i];
      const l = heatLuma[i];
      const p = i * 4;
      if (g < 0 || l < 0) {
        d[p + 3] = 0;
        continue;
      }
      // Per-cell wetness from the two signals that survive coarse sampling.
      const gn = normalise(g, cal.dry.glare, cal.wet.glare);
      const dn = normalise(1 - l / 255, cal.dry.darkness, cal.wet.darkness);
      const t = Math.max(0, Math.min(1, gn * 0.62 + dn * 0.38));
      const [r, gg, b] = ramp(t);
      d[p] = r;
      d[p + 1] = gg;
      d[p + 2] = b;
      // Ramp the alpha as well as the hue so dry tarmac stays close to its own
      // colour and only genuinely wet cells light up.
      d[p + 3] = Math.round((0.02 + 0.46 * t * t) * 255);
    }
    this.heatCtx.putImageData(img, 0, 0);

    const ctx = this.ctx;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(this.heatCanvas, ox, oy, sw, sh);
    ctx.restore();
  }

  private drawRois(cal: Calibration, toX: (n: number) => number, toY: (n: number) => number) {
    const ctx = this.ctx;

    // Road envelope
    const road = roadCorners(cal.road, 1, 1);
    ctx.save();
    ctx.strokeStyle = 'rgba(238,242,247,0.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    road.forEach((p, i) => (i ? ctx.lineTo(toX(p.x), toY(p.y)) : ctx.moveTo(toX(p.x), toY(p.y))));
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    for (const band of SUB_BANDS) {
      const style = BAND_STYLE[band.name];
      if (!style) continue;
      const pts = bandCorners(cal.road, band, 1, 1);
      ctx.save();
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(toX(p.x), toY(p.y)) : ctx.moveTo(toX(p.x), toY(p.y))));
      ctx.closePath();
      ctx.stroke();

      // Label low in the band, not at the horizon: up there the three
      // trapezoids converge and the captions overlap into an unreadable smear.
      const k = 0.72;
      const lx = toX(pts[0].x + (pts[3].x - pts[0].x) * k);
      const rx = toX(pts[1].x + (pts[2].x - pts[1].x) * k);
      const ly = toY(pts[0].y + (pts[3].y - pts[0].y) * k);
      ctx.font = '600 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(6,7,10,0.85)';
      ctx.strokeText(style.label, (lx + rx) / 2, ly);
      ctx.fillStyle = style.stroke;
      ctx.fillText(style.label, (lx + rx) / 2, ly);
      ctx.restore();
    }
  }
}

/** Amber (dry) → cyan (damp) → blue (wet). */
function ramp(t: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0.0, [255, 176, 32]],
    [0.5, [56, 189, 248]],
    [1.0, [79, 124, 255]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [ta, ca] = stops[i];
    const [tb, cb] = stops[i + 1];
    if (t <= tb) {
      const k = (t - ta) / Math.max(1e-6, tb - ta);
      return [
        Math.round(ca[0] + (cb[0] - ca[0]) * k),
        Math.round(ca[1] + (cb[1] - ca[1]) * k),
        Math.round(ca[2] + (cb[2] - ca[2]) * k),
      ];
    }
  }
  return stops[stops.length - 1][1];
}
