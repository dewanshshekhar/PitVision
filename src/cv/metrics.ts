import type { BandMetrics, FrameMetrics } from '../types';
import { bandSpan, roadBounds, SUB_BANDS, type Corridor } from './rois';

export interface GlareThresholds {
  /** Minimum normalised luma for a pixel to count as specular */
  v: number;
  /** Maximum HSV saturation — real reflections are near-white, not coloured */
  s: number;
}

const EMPTY: BandMetrics = {
  luma: 0, lumaP50: 0, lumaP95: 0, sat: 0, glare: 0, texture: 0, contrast: 0, pixels: 0,
};

/**
 * Every buffer the analysis pass touches is allocated once and reused.
 *
 * This matters more than it looks: at 12 Hz, per-frame allocation means the
 * garbage collector runs during the session, and a GC pause lands as a visible
 * stall in the readout at exactly the wrong moment. Nothing here allocates once
 * the pipeline is warm.
 */
let grayBuf: Float32Array | null = null;
let satBuf: Float32Array | null = null;
let skyMaskBuf: Uint8Array | null = null;
let bufW = 0;
let bufH = 0;

const hist = new Int32Array(256);
let heatGlareBuf: Float32Array | null = null;
let heatLumaBuf: Float32Array | null = null;
let cellCountBuf: Int32Array | null = null;
let cellGlareBuf: Int32Array | null = null;
let cellLumaBuf: Float32Array | null = null;
let heatCells = 0;

function ensureBuffers(w: number, h: number) {
  if (bufW === w && bufH === h && grayBuf && satBuf && skyMaskBuf) return;
  grayBuf = new Float32Array(w * h);
  satBuf = new Float32Array(w * h);
  skyMaskBuf = new Uint8Array(w * h);
  bufW = w;
  bufH = h;
}

function ensureHeatBuffers(cells: number) {
  if (heatCells === cells && heatGlareBuf) return;
  heatGlareBuf = new Float32Array(cells);
  heatLumaBuf = new Float32Array(cells);
  cellCountBuf = new Int32Array(cells);
  cellGlareBuf = new Int32Array(cells);
  cellLumaBuf = new Float32Array(cells);
  heatCells = cells;
}

/**
 * Allocate and touch every buffer ahead of time, so the first analysed frame of
 * a session costs the same as the thousandth. Called by the pre-race check.
 */
export function warmUp(sampleW: number, sampleH: number, heatW = 30, heatH = 16) {
  ensureBuffers(sampleW, sampleH);
  ensureHeatBuffers(heatW * heatH);
  grayBuf!.fill(0);
  satBuf!.fill(0);
  skyMaskBuf!.fill(0);
}

function percentile(hist: Int32Array, total: number, p: number): number {
  if (total === 0) return 0;
  const target = total * p;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= target) return i;
  }
  return 255;
}

/**
 * One analysis pass over a downscaled frame.
 *
 * Everything is computed in a single sweep per band: luma moments, an HSV
 * saturation mean, a specular-pixel count, and the variance of the 4-neighbour
 * Laplacian. The Laplacian is the surface-texture probe — dry asphalt is a
 * rough aggregate that produces a lot of high-frequency energy, and a film of
 * water fills those voids and mirrors the sky, collapsing the variance.
 */
export function analyseFrame(
  img: ImageData,
  corridor: Corridor,
  glare: GlareThresholds,
  heatW = 30,
  heatH = 16,
): FrameMetrics {
  const t0 = performance.now();
  const { width: w, height: h, data } = img;
  ensureBuffers(w, h);
  const gray = grayBuf!;
  const sat = satBuf!;

  // Pass 1 — luma + saturation, restricted to the ROI's bounding box.
  //
  // Scanning the whole frame was ~4x more work than the detector uses: on a
  // trackside shot most of the image is sky, barriers and run-off that no band
  // ever samples.
  const bounds = roadBounds(corridor, w, h);
  const skyMask = skyMaskBuf!;
  skyMask.fill(0);

  for (let y = bounds.y0; y <= bounds.y1; y++) {
    const row = y * w;
    const ny = y / h;
    for (let x = bounds.x0; x <= bounds.x1; x++) {
      const p = row + x;
      const i = p * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      // Rec. 601 luma: matches how the eye weights the channels.
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
      const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
      const s = mx === 0 ? 0 : (mx - mn) / mx;
      gray[p] = l;
      sat[p] = s;

      // Detect sky: blue-excess or top-of-frame overcast sky gradient
      if (ny < 0.44 && ((b > r + 8 && b > g) || (ny < 0.38 && l > 175 && s < 0.18))) {
        skyMask[p] = 1;
      }
    }
  }

  const vThresh = glare.v * 255;
  const out: Record<string, BandMetrics> = {};

  for (const band of SUB_BANDS) {
    hist.fill(0);
    let n = 0;
    let sumL = 0;
    let sumS = 0;
    let glareN = 0;
    let lapSum = 0;
    let lapSq = 0;
    let lapN = 0;

    for (let y = 1; y < h - 1; y++) {
      const span = bandSpan(corridor, band, y, w, h);
      if (!span) continue;
      const [x0, x1] = span;
      const row = y * w;
      for (let x = x0; x <= x1; x++) {
        const p = row + x;
        if (skyMask[p] === 1) continue; // Exclude sky from road metrics
        const l = gray[p];
        sumL += l;
        sumS += sat[p];
        hist[l < 0 ? 0 : l > 255 ? 255 : l | 0]++;
        if (l >= vThresh && sat[p] <= glare.s) glareN++;
        n++;

        const lap = 4 * l - gray[p - 1] - gray[p + 1] - gray[p - w] - gray[p + w];
        lapSum += lap;
        lapSq += lap * lap;
        lapN++;
      }
    }

    if (n === 0) {
      out[band.name] = { ...EMPTY };
      continue;
    }

    const mean = lapSum / lapN;
    const p50 = percentile(hist, n, 0.5);
    const p95 = percentile(hist, n, 0.95);
    out[band.name] = {
      luma: sumL / n,
      lumaP50: p50,
      lumaP95: p95,
      sat: sumS / n,
      glare: glareN / n,
      texture: Math.max(0, lapSq / lapN - mean * mean),
      contrast: (p95 - p50) / 255,
      pixels: n,
    };
  }

  // Coarse per-cell readings for the on-video heatmap.
  ensureHeatBuffers(heatW * heatH);
  const heatGlare = heatGlareBuf!.fill(-1);
  const heatLuma = heatLumaBuf!.fill(-1);
  const roadBand = SUB_BANDS[0];
  const cellCount = cellCountBuf!.fill(0);
  const cellGlare = cellGlareBuf!.fill(0);
  const cellLuma = cellLumaBuf!.fill(0);

  for (let y = 1; y < h - 1; y++) {
    const span = bandSpan(corridor, roadBand, y, w, h);
    if (!span) continue;
    const [x0, x1] = span;
    const cy = Math.min(heatH - 1, ((y / h) * heatH) | 0);
    const row = y * w;
    for (let x = x0; x <= x1; x++) {
      const p = row + x;
      if (skyMask[p] === 1) continue;
      const cx = Math.min(heatW - 1, ((x / w) * heatW) | 0);
      const c = cy * heatW + cx;
      cellCount[c]++;
      cellLuma[c] += gray[p];
      if (gray[p] >= vThresh && sat[p] <= glare.s) cellGlare[c]++;
    }
  }
  for (let c = 0; c < cellCount.length; c++) {
    if (cellCount[c] < 8) continue;
    heatGlare[c] = cellGlare[c] / cellCount[c];
    heatLuma[c] = cellLuma[c] / cellCount[c];
  }

  return {
    road: out.road,
    line: out.line,
    left: out.left,
    right: out.right,
    heatGlare,
    heatLuma,
    heatW,
    heatH,
    ms: performance.now() - t0,
  };
}

/** Collapse a band's raw metrics into the four signals the index consumes. */
export function toSignals(b: BandMetrics) {
  return {
    glare: b.glare,
    texture: b.texture,
    darkness: 1 - b.luma / 255,
    specular: b.contrast,
  };
}
