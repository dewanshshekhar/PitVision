export const BAND_STYLE: Record<string, { stroke: string; fill: string; label: string }> = {
  road: {
    stroke: 'rgba(70,224,138,0.95)',
    fill: 'rgba(70,224,138,0.08)',
    label: 'ROAD',
  },
  left: {
    stroke: 'rgba(56,189,248,0.9)',
    fill: 'rgba(56,189,248,0.12)',
    label: 'EDGE L',
  },
  right: {
    stroke: 'rgba(56,189,248,0.9)',
    fill: 'rgba(56,189,248,0.12)',
    label: 'EDGE R',
  },
};

/**
 * Fills establish the meaning (green road, blue edge samples). Strokes are a
 * separate pass with the full-road boundary last: otherwise the blue bands
 * repaint the same outer edges and make a correctly sized green road look
 * like two disconnected curves.
 */
export const BAND_FILL_ORDER = ['road', 'left', 'right'] as const;
export const BAND_STROKE_ORDER = ['left', 'right', 'road'] as const;
