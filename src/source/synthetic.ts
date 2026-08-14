import { clamp, lerp } from '../util/math';
import type { FrameSource } from '../cv/engine';

const W = 720;
const H = 405;
const SLICES = 44;

const smoothstep = (t: number) => {
  const x = clamp(t);
  return x * x * (3 - 2 * x);
};

/** Deterministic pseudo-random so the highlight field is stable frame to frame. */
function hash(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

interface Keyframe {
  t: number;
  edge: number;
  line: number;
  rain: number;
}

/**
 * A 72-second weather cycle covering every state the detector has to call,
 * including a drying phase where the racing line clears well ahead of the
 * edges. This exists so the pipeline can be built, calibrated, and rehearsed
 * before real footage lands, and so the demo has a guaranteed fallback if the
 * clip fails on the day.
 */
const SCRIPT: Keyframe[] = [
  { t: 0,  edge: 0.05, line: 0.04, rain: 0 },
  { t: 12, edge: 0.05, line: 0.04, rain: 0 },
  { t: 17, edge: 0.42, line: 0.40, rain: 0.7 },
  { t: 23, edge: 0.90, line: 0.88, rain: 1 },
  { t: 35, edge: 0.90, line: 0.86, rain: 0.85 },
  { t: 40, edge: 0.84, line: 0.62, rain: 0.2 },
  { t: 47, edge: 0.72, line: 0.30, rain: 0 },
  { t: 56, edge: 0.55, line: 0.10, rain: 0 },
  { t: 66, edge: 0.12, line: 0.05, rain: 0 },
  { t: 72, edge: 0.05, line: 0.04, rain: 0 },
];

export const SCENARIO_LENGTH = 72;

function sampleScript(t: number) {
  const tt = ((t % SCENARIO_LENGTH) + SCENARIO_LENGTH) % SCENARIO_LENGTH;
  for (let i = 0; i < SCRIPT.length - 1; i++) {
    const a = SCRIPT[i];
    const b = SCRIPT[i + 1];
    if (tt >= a.t && tt <= b.t) {
      const k = smoothstep((tt - a.t) / Math.max(1e-6, b.t - a.t));
      return {
        edge: lerp(a.edge, b.edge, k),
        line: lerp(a.line, b.line, k),
        rain: lerp(a.rain, b.rain, k),
      };
    }
  }
  return { edge: SCRIPT[0].edge, line: SCRIPT[0].line, rain: SCRIPT[0].rain };
}

export class SyntheticSource implements FrameSource {
  readonly canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private grain: HTMLCanvasElement;
  private scroll = 0;

  time = 0;
  speed = 1;
  /**
   * Where the camera is.
   *
   * `onboard` scrolls the surface toward the viewer, as a car-mounted camera
   * sees it. `trackside` is a fixed camera on the outside of a corner looking
   * down the straight: the tarmac is static and cars come through it. Both keep
   * the track's full width across the frame, which is what the racing-line
   * versus edge comparison needs — and which a cockpit camera cannot give,
   * because its own front wheels sit exactly where the edges would be.
   */
  view: 'onboard' | 'trackside' = 'onboard';
  /** When true the script is frozen and edgeWet/lineWet are driven manually. */
  manual = false;
  edgeWet = 0.05;
  lineWet = 0.05;
  rain = 0;

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.grain = buildGrain();
    this.render();
  }

  get drawable() { return this.canvas; }
  get width() { return W; }
  get height() { return H; }
  get ready() { return true; }

  get phase(): string {
    if (this.manual) return 'Manual';
    const t = this.time % SCENARIO_LENGTH;
    if (t < 12) return 'Dry';
    if (t < 23) return 'Rain onset';
    if (t < 36) return 'Heavy rain';
    if (t < 58) return 'Drying — line clearing';
    return 'Dry-out';
  }

  update(dtMs: number) {
    const dt = (dtMs / 1000) * this.speed;
    if (!this.manual) {
      this.time += dt;
      const s = sampleScript(this.time);
      this.edgeWet = s.edge;
      this.lineWet = s.line;
      this.rain = s.rain;
    }
    // Scroll speed falls as the surface soaks — mostly a visual cue that the
    // car has slowed, but it also keeps the grain from looking like a still.
    // A fixed trackside camera sees static tarmac; only the cars move.
    if (this.view === 'onboard') {
      this.scroll = (this.scroll + dt * 260 * (1 - 0.25 * this.edgeWet)) % 512;
    }
    if (this.view === 'trackside') this.advanceCars(dt);
    this.render();
  }

  /** Cars running down the racing line, spaced so the ROI is never permanently blocked. */
  private cars: { t: number; lane: number; hue: string }[] = [];
  private carTimer = 0;

  private advanceCars(dt: number) {
    this.carTimer -= dt;
    if (this.carTimer <= 0) {
      this.carTimer = 1.6 + Math.random() * 2.2;
      const palette = ['#d42b2b', '#2b6fd4', '#e8a219', '#25a55c', '#8d59d8'];
      this.cars.push({
        t: 0,
        // Cars run near the racing line, with a little spread — which is what
        // rubbers the line in and dries it first.
        lane: 0.5 + (Math.random() - 0.5) * 0.16,
        hue: palette[(Math.random() * palette.length) | 0],
      });
    }
    for (const c of this.cars) c.t += dt * 0.42;
    this.cars = this.cars.filter((c) => c.t < 1.15);
  }

  private drawCars() {
    const ctx = this.ctx;
    const yTop = 0.52 * H;
    const span = H - yTop;
    for (const car of this.cars) {
      const t = car.t;
      const y = yTop + span * t;
      const halfW = (lerp(0.34, 1.14, t) * W) / 2;
      const x = W / 2 + (car.lane - 0.5) * halfW * 2;
      const s = lerp(0.16, 1.0, t);
      const bw = 96 * s;
      const bh = 34 * s;

      // Spray kicked up behind the car, proportional to how much water is down.
      if (this.edgeWet > 0.25) {
        const a = 0.5 * this.edgeWet * s;
        const g = ctx.createRadialGradient(x, y - bh * 0.4, 0, x, y - bh * 0.4, bw * 1.1);
        g.addColorStop(0, `rgba(226,234,244,${a.toFixed(3)})`);
        g.addColorStop(1, 'rgba(226,234,244,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(x, y - bh * 0.5, bw * 1.15, bh * 1.3, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.save();
      ctx.translate(x, y);
      // Tyres
      ctx.fillStyle = '#15161a';
      ctx.fillRect(-bw * 0.52, -bh * 0.42, bw * 0.2, bh * 0.6);
      ctx.fillRect(bw * 0.32, -bh * 0.42, bw * 0.2, bh * 0.6);
      // Body + airbox
      ctx.fillStyle = car.hue;
      ctx.beginPath();
      ctx.roundRect(-bw * 0.3, -bh * 0.75, bw * 0.6, bh * 0.85, bh * 0.2);
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath();
      ctx.roundRect(-bw * 0.12, -bh * 0.62, bw * 0.24, bh * 0.3, bh * 0.1);
      ctx.fill();
      // Rear wing
      ctx.fillStyle = car.hue;
      ctx.fillRect(-bw * 0.42, -bh * 0.95, bw * 0.84, bh * 0.16);
      // Rain light
      if (this.edgeWet > 0.35) {
        ctx.fillStyle = `rgba(255,40,40,${(0.5 + 0.5 * Math.sin(this.time * 9)).toFixed(2)})`;
        ctx.fillRect(-bw * 0.05, -bh * 0.3, bw * 0.1, bh * 0.14);
      }
      ctx.restore();
    }
  }

  private roadPath(u0: number, u1: number): Path2D {
    const yTop = 0.52 * H;
    const yBot = H;
    const xTopL = lerp(0.33, 0.67, u0) * W;
    const xTopR = lerp(0.33, 0.67, u1) * W;
    const xBotL = lerp(-0.06, 1.06, u0) * W;
    const xBotR = lerp(-0.06, 1.06, u1) * W;
    const p = new Path2D();
    p.moveTo(xTopL, yTop);
    p.lineTo(xTopR, yTop);
    p.lineTo(xBotR, yBot);
    p.lineTo(xBotL, yBot);
    p.closePath();
    return p;
  }

  private render() {
    const ctx = this.ctx;
    const wetAvg = (this.edgeWet + this.lineWet) / 2;

    // Sky — greys out and drops in luminance as the front arrives.
    const sky = ctx.createLinearGradient(0, 0, 0, 0.56 * H);
    sky.addColorStop(0, mix('#5c86b8', '#33383e', wetAvg));
    sky.addColorStop(1, mix('#b9cfe2', '#6a7078', wetAvg));
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, 0.56 * H);

    // Treeline / barrier band on the horizon.
    ctx.fillStyle = mix('#2d3a2c', '#242a2c', wetAvg);
    ctx.fillRect(0, 0.47 * H, W, 0.07 * H);
    ctx.fillStyle = mix('#d8dde2', '#8d949a', wetAvg);
    ctx.fillRect(0, 0.505 * H, W, 0.012 * H);

    // Run-off either side of the circuit. Without it the frame has black
    // wedges outside the road trapezoid, which is both ugly and unrepresentative
    // of what a trackside camera actually sees.
    const ground = ctx.createLinearGradient(0, 0.52 * H, 0, H);
    ground.addColorStop(0, mix('#3c4a33', '#2a3129', wetAvg));
    ground.addColorStop(1, mix('#55603f', '#343a2e', wetAvg));
    ctx.fillStyle = ground;
    ctx.fillRect(0, 0.52 * H, W, H * 0.48);

    // Surface: edges first, then the racing line clipped on top so the two
    // zones can carry independent wetness.
    this.drawSurface(this.roadPath(-0.02, 1.02), this.edgeWet, 11);
    this.drawSurface(this.roadPath(0.335, 0.665), this.lineWet, 23);

    this.drawKerbs();
    if (this.view === 'trackside') this.drawCars();
    if (this.rain > 0.02) this.drawRain();
    this.vignette();
  }

  private drawSurface(clip: Path2D, wet: number, seed: number) {
    const ctx = this.ctx;
    ctx.save();
    ctx.clip(clip);

    // Base tone: water darkens asphalt and pulls it slightly blue.
    ctx.fillStyle = mix('#57575a', '#1e2126', wet);
    ctx.fillRect(0, 0.5 * H, W, H * 0.5);

    // Aggregate grain, drawn as perspective slices. Its opacity is the whole
    // point: a water film fills the voids in the aggregate and the surface
    // stops scattering, which is exactly what the Laplacian variance measures.
    const grainAlpha = lerp(0.5, 0.07, smoothstep(wet * 1.15));
    ctx.globalAlpha = grainAlpha;
    const yTop = 0.52 * H;
    const span = H - yTop;
    for (let i = 0; i < SLICES; i++) {
      const t0 = i / SLICES;
      const t1 = (i + 1) / SLICES;
      const y0 = yTop + span * t0;
      const y1 = yTop + span * t1;
      const w0 = lerp(0.34, 1.14, t0) * W;
      const w1 = lerp(0.34, 1.14, t1) * W;
      const dw = Math.max(w0, w1);
      const sy = (this.scroll + t0 * 380) % 512;
      ctx.drawImage(
        this.grain,
        0, sy, 256, Math.max(1, 512 / SLICES),
        (W - dw) / 2, y0, dw, Math.max(1, y1 - y0 + 1),
      );
    }
    ctx.globalAlpha = 1;

    // Specular reflection: bright, near-white, low-saturation patches. This is
    // the signal a human reads as "shiny", and it is the heaviest-weighted
    // input to the index.
    if (wet > 0.12) {
      const strength = smoothstep((wet - 0.12) / 0.6);
      ctx.globalCompositeOperation = 'lighter';
      // Jittered grid rather than pure random placement. With a free-random
      // field the reflection density differs between the centre and the outer
      // bands purely by chance, which shows up as a phantom line-versus-edge
      // divergence on a surface that is uniformly wet.
      const GX = 9;
      const GY = 6;
      const count = GX * GY;
      // Both axes drift, at rates that do not share a short common period. A
      // static field would leave a permanent density imbalance between the
      // centre and the outer bands; drifting it makes the field uniform once
      // averaged over a second or two, which is what the engine's smoothing
      // window sees anyway.
      const driftX = this.time * 0.21;
      const driftY = this.time * 0.11;
      for (let i = 0; i < count; i++) {
        const gx = i % GX;
        const gy = (i / GX) | 0;
        const rx = ((gx + 0.15 + 0.7 * hash(i * 3.1 + seed)) / GX + driftX) % 1;
        const ry = ((gy + 0.15 + 0.7 * hash(i * 7.7 + seed * 2)) / GY + driftY) % 1;
        const t = 0.12 + ry * 0.88;
        const y = yTop + span * t;
        const halfW = (lerp(0.34, 1.14, t) * W) / 2;
        const x = W / 2 + (rx * 2 - 1) * halfW;
        const flicker = 0.68 + 0.32 * Math.sin(this.time * 2.2 + i * 1.7);
        const rr = lerp(4, 26, t) * (0.62 + hash(i * 11.3 + seed) * 0.7);
        const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
        // A wet surface mirrors the sky, so real reflections come close to
        // blowing out. The plateau matters as much as the peak: it is what
        // gives the specular detector an area to measure rather than a spike.
        const a = 0.94 * strength * flicker;
        g.addColorStop(0, `rgba(238,244,252,${a.toFixed(3)})`);
        g.addColorStop(0.4, `rgba(238,244,252,${(a * 0.82).toFixed(3)})`);
        g.addColorStop(1, 'rgba(238,244,252,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(x, y, rr * 1.5, rr * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
  }

  private drawKerbs() {
    const ctx = this.ctx;
    const yTop = 0.52 * H;
    const span = H - yTop;
    for (let i = 0; i < 26; i++) {
      const t0 = i / 26;
      const t1 = (i + 1) / 26;
      const y0 = yTop + span * t0;
      const y1 = yTop + span * t1;
      const phase = Math.floor((i + this.scroll / 42) % 2);
      ctx.fillStyle = phase === 0 ? 'rgba(196,58,52,0.85)' : 'rgba(226,228,230,0.85)';
      const lOut = lerp(0.325, -0.07, t0) * W;
      const lIn = lerp(0.352, 0.045, t0) * W;
      const rIn = lerp(0.648, 0.955, t0) * W;
      const rOut = lerp(0.675, 1.07, t0) * W;
      ctx.beginPath();
      ctx.moveTo(lOut, y0); ctx.lineTo(lIn, y0);
      ctx.lineTo(lerp(0.352, 0.045, t1) * W, y1); ctx.lineTo(lerp(0.325, -0.07, t1) * W, y1);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(rIn, y0); ctx.lineTo(rOut, y0);
      ctx.lineTo(lerp(0.675, 1.07, t1) * W, y1); ctx.lineTo(lerp(0.648, 0.955, t1) * W, y1);
      ctx.closePath(); ctx.fill();
    }
  }

  private drawRain() {
    const ctx = this.ctx;
    const n = Math.round(this.rain * 170);
    ctx.strokeStyle = `rgba(198,214,232,${(0.18 + 0.22 * this.rain).toFixed(3)})`;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    const drift = (performance.now() / 1000) * 900;
    for (let i = 0; i < n; i++) {
      const x = (hash(i * 1.7) * W + drift * 0.15) % W;
      const y = (hash(i * 5.3) * H + drift + i * 13) % H;
      const len = 12 + hash(i * 9.1) * 20;
      ctx.moveTo(x, y);
      ctx.lineTo(x - 3, y + len);
    }
    ctx.stroke();
  }

  private vignette() {
    const ctx = this.ctx;
    const g = ctx.createRadialGradient(W / 2, H * 0.58, H * 0.25, W / 2, H * 0.58, H * 0.95);
    // Kept light on purpose: a heavy vignette darkens the ROI's outer bands and
    // manufactures a standing line-versus-edge bias that has nothing to do with water.
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.2)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
}

function buildGrain(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(256, 512);
  const d = img.data;
  // 2px cells so the grain survives the downscale to the 384px analysis frame.
  for (let y = 0; y < 512; y += 2) {
    for (let x = 0; x < 256; x += 2) {
      const v = 90 + Math.random() * 130;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const p = ((y + dy) * 256 + (x + dx)) * 4;
          const j = v + (Math.random() - 0.5) * 40;
          d[p] = d[p + 1] = d[p + 2] = j;
          d[p + 3] = 255;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function mix(a: string, b: string, t: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  const k = clamp(t);
  return `rgb(${Math.round(lerp(pa[0], pb[0], k))},${Math.round(lerp(pa[1], pb[1], k))},${Math.round(lerp(pa[2], pb[2], k))})`;
}

function parseHex(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
