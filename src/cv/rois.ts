import { lerp } from '../util/math';
import { sampleAt, type LaneTrace } from './lane';

/**
 * The road surface as a perspective trapezoid in normalised frame coordinates.
 * A trackside or onboard camera sees the road narrow toward the horizon, so a
 * plain rectangle would sample sky and barriers along with tarmac.
 */
export interface RoadGeometry {
  yTop: number;
  yBot: number;
  xTopL: number;
  xTopR: number;
  xBotL: number;
  xBotR: number;
}

/** A vertical slice of the road, expressed as a fraction of the road's width at each row. */
export interface SubBand {
  name: 'road' | 'line' | 'left' | 'right';
  u0: number;
  u1: number;
}

/**
 * What the sampler measures through.
 *
 * The pipeline used to take a `RoadGeometry` — four corners, straight sides —
 * everywhere. That is now one of two things that can describe the road, the
 * other being a traced corridor that follows it round a corner. Everything
 * downstream works against this interface instead, so the manual ROI and the
 * automatic trace go through exactly the same measurement code and cannot
 * drift apart.
 */
export interface Corridor {
  /** Normalised depth of the near and far ends. */
  yTop: number;
  yBot: number;
  /** Left and right boundary at a normalised depth, or null outside the corridor. */
  edgesAt(ny: number): [number, number] | null;
  /** Widest normalised x extent, for the bounding box the pixel pass covers. */
  extent: { x0: number; x1: number };
  /** True when this came from a live trace rather than a hand-placed shape. */
  traced: boolean;
}

/** The hand-placed trapezoid, as a corridor. */
export function corridorFromRoad(road: RoadGeometry): Corridor {
  return {
    yTop: road.yTop,
    yBot: road.yBot,
    traced: false,
    edgesAt(ny) {
      if (ny < road.yTop || ny > road.yBot) return null;
      const t = (ny - road.yTop) / Math.max(1e-6, road.yBot - road.yTop);
      return [lerp(road.xTopL, road.xBotL, t), lerp(road.xTopR, road.xBotR, t)];
    },
    extent: {
      x0: Math.min(road.xTopL, road.xBotL),
      x1: Math.max(road.xTopR, road.xBotR),
    },
  };
}

/**
 * A traced lane, as a corridor.
 *
 * The traced boundaries are the *track limits* — where the tarmac stops. The
 * bands are then taken inside an inset from those, for the same reason the
 * hand-placed trapezoid is drawn conservatively: the last few per cent of the
 * width is where the white line and the kerb live, and painted kerbing is
 * bright and near-colourless, which the specular signal reads as standing
 * water. Sampling right up to the traced edge would manufacture a dry line
 * every time the corridor was accurate.
 */
const TRACE_INSET = 0.06;

export function corridorFromTrace(trace: LaneTrace): Corridor {
  let x0 = 1;
  let x1 = 0;
  for (let i = 0; i < trace.left.length; i++) {
    if (trace.left[i] < x0) x0 = trace.left[i];
    if (trace.right[i] > x1) x1 = trace.right[i];
  }
  return {
    yTop: trace.yTop,
    yBot: trace.yBot,
    traced: true,
    edgesAt(ny) {
      if (ny < trace.yTop || ny > trace.yBot) return null;
      const [l, r] = sampleAt(trace, ny);
      const inset = (r - l) * TRACE_INSET;
      return [l + inset, r - inset];
    },
    extent: { x0, x1 },
  };
}

/**
 * Deliberately conservative: inset from the track limits so kerbs, white lines
 * and run-off never enter the sample. Painted kerbing is bright and
 * desaturated, which reads as specular reflection and manufactures a false
 * divergence between the line and the edges — the single easiest way to make
 * this pipeline lie.
 */
export const DEFAULT_ROAD: RoadGeometry = {
  yTop: 0.55,
  yBot: 0.97,
  xTopL: 0.375,
  xTopR: 0.625,
  xBotL: 0.11,
  xBotR: 0.89,
};

/**
 * The racing line is the centre third — the strip rubbered in and swept by
 * traffic. The edge bands sit outside it, where standing water lingers.
 * The gaps between them are deliberate: they keep the two populations distinct
 * so the divergence signal stays clean.
 */
export const SUB_BANDS: SubBand[] = [
  { name: 'road', u0: 0.0, u1: 1.0 },
  { name: 'line', u0: 0.34, u1: 0.66 },
  { name: 'left', u0: 0.0, u1: 0.22 },
  { name: 'right', u0: 0.78, u1: 1.0 },
];

/** Pixel-space x range of a sub-band on a given row. Returns null if the row is outside the road. */
export function bandSpan(
  corridor: Corridor,
  band: SubBand,
  y: number,
  w: number,
  h: number,
): [number, number] | null {
  const edges = corridor.edgesAt(y / h);
  if (!edges) return null;
  const a = lerp(edges[0], edges[1], band.u0) * w;
  const b = lerp(edges[0], edges[1], band.u1) * w;
  const x0 = Math.max(1, Math.floor(Math.min(a, b)));
  const x1 = Math.min(w - 2, Math.ceil(Math.max(a, b)));
  if (x1 <= x0) return null;
  return [x0, x1];
}

/**
 * Pixel bounding box of the road trapezoid, inflated by one pixel.
 *
 * The per-pixel pass only needs to cover this box, not the frame: the ROI is
 * typically a fifth of the image, and everything above the horizon is sky the
 * detector never looks at. The one-pixel margin exists because the Laplacian
 * reads its four neighbours.
 */
export function roadBounds(corridor: Corridor, w: number, h: number) {
  const x0 = Math.max(1, Math.floor(corridor.extent.x0 * w) - 1);
  const x1 = Math.min(w - 2, Math.ceil(corridor.extent.x1 * w) + 1);
  const y0 = Math.max(1, Math.floor(corridor.yTop * h) - 1);
  const y1 = Math.min(h - 2, Math.ceil(corridor.yBot * h) + 1);
  return { x0, x1, y0, y1 };
}

/** The trapezoid's four corners in pixel space. Only meaningful for a hand-placed ROI. */
export function roadCorners(road: RoadGeometry, w: number, h: number) {
  return [
    { x: road.xTopL * w, y: road.yTop * h },
    { x: road.xTopR * w, y: road.yTop * h },
    { x: road.xBotR * w, y: road.yBot * h },
    { x: road.xBotL * w, y: road.yBot * h },
  ];
}

/**
 * The outline of a band as a closed polygon, sampled down one side and back up
 * the other.
 *
 * Per-row rather than four corners: a traced corridor bends, and drawing it as
 * a quadrilateral would show the operator a straight-sided shape while the
 * detector measured a curved one. The overlay is how anyone checks the region
 * is on the tarmac, so it has to show the region that is actually sampled.
 */
export function bandOutline(corridor: Corridor, band: SubBand, w: number, h: number, steps = 24) {
  const left: { x: number; y: number }[] = [];
  const right: { x: number; y: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const ny = corridor.yTop + ((corridor.yBot - corridor.yTop) * i) / steps;
    const edges = corridor.edgesAt(ny);
    if (!edges) continue;
    const y = ny * h;
    left.push({ x: lerp(edges[0], edges[1], band.u0) * w, y });
    right.push({ x: lerp(edges[0], edges[1], band.u1) * w, y });
  }
  return [...left, ...right.reverse()];
}
