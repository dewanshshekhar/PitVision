export function $<T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Element not found: ${sel}`);
  return el;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

/** Size a canvas to its CSS box at device pixel ratio. Returns the CSS-pixel size. */
export function fitCanvas(canvas: HTMLCanvasElement): { w: number; h: number; dpr: number } {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h, dpr };
}

/**
 * The mapping applied by `object-fit: cover`. Overlays are authored in
 * source-frame coordinates, so without this they would drift whenever the feed
 * and the stage disagree on aspect ratio.
 */
export function coverTransform(stageW: number, stageH: number, srcW: number, srcH: number) {
  if (!srcW || !srcH) return { ox: 0, oy: 0, sw: stageW, sh: stageH };
  const scale = Math.max(stageW / srcW, stageH / srcH);
  const sw = srcW * scale;
  const sh = srcH * scale;
  return { ox: (stageW - sw) / 2, oy: (stageH - sh) / 2, sw, sh };
}

let toastTimer = 0;
export function toast(message: string) {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.classList.remove('show'), 2600);
}
