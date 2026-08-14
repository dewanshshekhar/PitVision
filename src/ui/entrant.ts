import { el } from '../util/dom';

/**
 * Who and what we're watching.
 *
 * Deliberately data the operator supplies rather than anything scraped or
 * bundled: team liveries, driver portraits and sponsor marks are owned assets,
 * and shipping them inside the app would be passing off someone else's
 * property as ours. The portrait slot takes a file the user chooses; until then
 * it renders a generated placeholder that is obviously a placeholder.
 */
export interface Entrant {
  driver: string;
  code: string;
  number: string;
  team: string;
  car: string;
  circuit: string;
  session: string;
  /** Team accent, used for the stripe and the number plate. */
  colour: string;
  /** Object URL for a portrait the user picked. Never fetched from the network. */
  portrait: string | null;
}

export const DEFAULT_ENTRANT: Entrant = {
  driver: 'Ingo Gerstl',
  code: 'GER',
  number: '14',
  team: 'Top Speed',
  car: 'Toro Rosso STR1 · Cosworth V10',
  circuit: 'TT Circuit Assen',
  session: 'Demo run',
  colour: '#1e5bc6',
  portrait: null,
};

const KEY = 'pitvision.entrant.v1';

export function loadEntrant(): Entrant {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_ENTRANT };
    // A portrait is an object URL from a previous session and is already dead —
    // never restore it.
    return { ...DEFAULT_ENTRANT, ...(JSON.parse(raw) as Partial<Entrant>), portrait: null };
  } catch {
    return { ...DEFAULT_ENTRANT };
  }
}

export function saveEntrant(e: Entrant) {
  try {
    const { portrait, ...rest } = e;
    void portrait;
    localStorage.setItem(KEY, JSON.stringify(rest));
  } catch {
    /* private mode */
  }
}

/** Generated silhouette — unmistakably a placeholder, not a likeness. */
function placeholderPortrait(colour: string): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('class', 'portrait-svg');
  const bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('width', '64');
  bg.setAttribute('height', '64');
  bg.setAttribute('fill', 'rgba(255,255,255,0.04)');
  const helmet = document.createElementNS(ns, 'path');
  // Helmet outline with a visor cut — reads as "a driver" without being anyone.
  helmet.setAttribute(
    'd',
    'M32 14c-11 0-19 8-19 19v13h38V33c0-11-8-19-19-19zm-14 20c0-8 6-14 14-14s14 6 14 14v3H18z',
  );
  helmet.setAttribute('fill', colour);
  helmet.setAttribute('opacity', '0.85');
  svg.append(bg, helmet);
  return svg;
}

export function renderEntrant(root: HTMLElement, e: Entrant, onEdit: () => void) {
  root.style.setProperty('--team', e.colour);

  const portrait = el('div', { class: 'portrait' });
  if (e.portrait) {
    const img = el('img', { src: e.portrait, alt: `${e.driver} portrait` });
    portrait.append(img);
  } else {
    portrait.append(placeholderPortrait(e.colour));
  }

  const editBtn = el('button', { class: 'btn ghost tiny' }, 'Edit');
  editBtn.addEventListener('click', onEdit);

  root.replaceChildren(
    el('div', { class: 'entrant-stripe' }),
    portrait,
    el(
      'div',
      { class: 'entrant-id' },
      el('div', { class: 'entrant-team' }, e.team),
      el(
        'div',
        { class: 'entrant-name' },
        el('span', { class: 'entrant-num' }, e.number),
        el('span', {}, e.driver),
      ),
      el('div', { class: 'entrant-car' }, e.car),
      el('div', { class: 'entrant-meta' }, `${e.circuit} · ${e.session}`),
    ),
    el('div', { class: 'entrant-actions' }, editBtn),
  );
}
