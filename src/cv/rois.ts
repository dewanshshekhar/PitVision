import { lerp } from '../util/math';

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
  road: RoadGeometry,
  band: SubBand,
  y: number,
  w: number,
  h: number,
): [number, number] | null {
  const ny = y / h;
  if (ny < road.yTop || ny > road.yBot) return null;
  const t = (ny - road.yTop) / Math.max(1e-6, road.yBot - road.yTop);
  const xl = lerp(road.xTopL, road.xBotL, t);
  const xr = lerp(road.xTopR, road.xBotR, t);
  const a = lerp(xl, xr, band.u0) * w;
  const b = lerp(xl, xr, band.u1) * w;
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
export function roadBounds(road: RoadGeometry, w: number, h: number) {
  const x0 = Math.max(1, Math.floor(Math.min(road.xTopL, road.xBotL) * w) - 1);
  const x1 = Math.min(w - 2, Math.ceil(Math.max(road.xTopR, road.xBotR) * w) + 1);
  const y0 = Math.max(1, Math.floor(road.yTop * h) - 1);
  const y1 = Math.min(h - 2, Math.ceil(road.yBot * h) + 1);
  return { x0, x1, y0, y1 };
}

/** The trapezoid's four corners in pixel space — used for the overlay. */
export function roadCorners(road: RoadGeometry, w: number, h: number) {
  return [
    { x: road.xTopL * w, y: road.yTop * h },
    { x: road.xTopR * w, y: road.yTop * h },
    { x: road.xBotR * w, y: road.yBot * h },
    { x: road.xBotL * w, y: road.yBot * h },
  ];
}

export function bandCorners(road: RoadGeometry, band: SubBand, w: number, h: number) {
  const topL = lerp(road.xTopL, road.xTopR, band.u0);
  const topR = lerp(road.xTopL, road.xTopR, band.u1);
  const botL = lerp(road.xBotL, road.xBotR, band.u0);
  const botR = lerp(road.xBotL, road.xBotR, band.u1);
  return [
    { x: topL * w, y: road.yTop * h },
    { x: topR * w, y: road.yTop * h },
    { x: botR * w, y: road.yBot * h },
    { x: botL * w, y: road.yBot * h },
  ];
}
