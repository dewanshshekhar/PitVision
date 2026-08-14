import { clamp } from '../util/math';
import { fitCanvas } from '../util/dom';

interface Streak { x: number; y: number; len: number; speed: number; a: number }
interface Mote { x: number; y: number; phase: number; speed: number }

/**
 * Ambient field over the feed. Density, speed and opacity are driven by the
 * live wetness index rather than a timer, so the atmosphere is data — when the
 * rain thins out on screen, it is because the index fell.
 */
export class ParticleField {
  private ctx: CanvasRenderingContext2D;
  private streaks: Streak[] = [];
  private motes: Mote[] = [];
  private last = performance.now();
  private w = 0;
  private h = 0;
  enabled = true;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  private seed(w: number, h: number) {
    if (this.w === w && this.h === h && this.streaks.length) return;
    this.w = w;
    this.h = h;
    this.streaks = Array.from({ length: 220 }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      len: 9 + Math.random() * 26,
      speed: 380 + Math.random() * 520,
      a: 0.12 + Math.random() * 0.4,
    }));
    this.motes = Array.from({ length: 46 }, () => ({
      x: Math.random() * w,
      y: h * (0.45 + Math.random() * 0.5),
      phase: Math.random() * Math.PI * 2,
      speed: 0.3 + Math.random() * 0.8,
    }));
  }

  draw(wetness: number) {
    const { w, h } = fitCanvas(this.canvas);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    if (!this.enabled) return;
    this.seed(w, h);

    const now = performance.now();
    const dt = Math.min(0.06, (now - this.last) / 1000);
    this.last = now;

    const wet = clamp(wetness / 100);

    if (wet > 0.15) {
      const active = Math.round(this.streaks.length * clamp((wet - 0.15) / 0.7));
      ctx.strokeStyle = `rgba(200,222,246,${(0.1 + 0.26 * wet).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < active; i++) {
        const s = this.streaks[i];
        s.y += s.speed * dt * (0.55 + wet);
        s.x -= s.speed * dt * 0.12;
        if (s.y > h) { s.y = -s.len; s.x = Math.random() * w; }
        if (s.x < -10) s.x = w + 10;
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x - s.len * 0.16, s.y + s.len);
      }
      ctx.stroke();
    }

    // Heat shimmer when the surface is dry — sparse, slow, low contrast.
    if (wet < 0.35) {
      const strength = (1 - wet / 0.35) * 0.5;
      ctx.fillStyle = `rgba(255,196,120,${(0.05 * strength).toFixed(3)})`;
      for (const m of this.motes) {
        m.phase += dt * m.speed;
        const y = m.y + Math.sin(m.phase) * 4;
        ctx.beginPath();
        ctx.ellipse(m.x, y, 12, 2.2, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
