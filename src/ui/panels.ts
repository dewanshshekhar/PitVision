import type { FrameMetrics, Signals } from '../types';
import type { Calibration } from '../cv/calibration';
import { DEFAULT_CALIBRATION, resetCalibration } from '../cv/calibration';
import { toSignals } from '../cv/metrics';
import { el, toast } from '../util/dom';

interface PanelDeps {
  get(): Calibration;
  set(next: Calibration): void;
  metrics(): FrameMetrics | null;
  /** Freeze/unfreeze the synthetic scene at a fixed wetness, for sampling anchors. */
  holdScene(wetness: number | null): void;
  /** Whether the synthetic scene is the live feed — the hold controls only apply to it. */
  sceneLive(): boolean;
}

type Num = number;

function slider(
  label: string,
  min: Num,
  max: Num,
  step: Num,
  get: () => Num,
  set: (v: Num) => void,
  fmt: (v: Num) => string = (v) => String(v),
): { node: HTMLElement; sync: () => void } {
  const out = el('output', {}, fmt(get()));
  const input = el('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(get()),
  }) as HTMLInputElement;
  input.addEventListener('input', () => {
    const v = Number(input.value);
    set(v);
    out.textContent = fmt(v);
  });
  const node = el('div', { class: 'field' }, el('label', {}, label), out, input);
  return {
    node,
    sync: () => {
      input.value = String(get());
      out.textContent = fmt(get());
    },
  };
}

const SIGNAL_LABELS: [keyof Signals, string][] = [
  ['glare', 'Specular glare'],
  ['texture', 'Texture (Laplacian)'],
  ['darkness', 'Darkness'],
  ['specular', 'Highlight spread'],
];

export function buildCalibrationPanel(root: HTMLElement, state: HTMLElement, deps: PanelDeps) {
  const syncs: (() => void)[] = [];
  const cal = () => deps.get();
  const commit = () => {
    deps.set(cal());
    refreshState();
  };

  // ── Anchors ──────────────────────────────────────────────────────────
  const table = el('table', { class: 'anchor-table' });
  const anchorGroup = el(
    'div',
    { class: 'group' },
    el('h4', {}, 'Calibration anchors'),
    el(
      'p',
      { class: 'hint' },
      'Park the feed on known-dry tarmac and sample it, then do the same on wet. ' +
        'Every signal is then normalised between those two points, so thresholds mean the same thing on any footage.',
    ),
    table,
  );

  const sampleRow = el('div', { class: 'row' });
  const mkSample = (which: 'dry' | 'wet') => {
    const b = el('button', { class: 'btn' }, `Sample as ${which}`);
    b.addEventListener('click', () => {
      const m = deps.metrics();
      if (!m || m.road.pixels === 0) {
        toast('No frames analysed yet');
        return;
      }
      const c = cal();
      c[which] = toSignals(m.road);
      deps.set(c);
      renderAnchors();
      refreshState();
      toast(`${which === 'dry' ? 'Dry' : 'Wet'} anchor captured from the current frame`);
    });
    return b;
  };
  sampleRow.append(mkSample('dry'), mkSample('wet'));

  const mkHold = (label: string, wetness: number | null, message: string) => {
    const b = el('button', { class: 'btn ghost' }, label);
    b.addEventListener('click', () => {
      if (!deps.sceneLive()) {
        toast('Switch to the synthetic scene to use the hold controls');
        return;
      }
      deps.holdScene(wetness);
      toast(message);
    });
    return b;
  };
  sampleRow.append(
    mkHold('Hold dry', 0.05, 'Scene held dry — now sample it'),
    mkHold('Hold wet', 0.9, 'Scene held wet — now sample it'),
    mkHold('Release', null, 'Scene resumed'),
  );

  const resetBtn = el('button', { class: 'btn ghost' }, 'Reset all');
  resetBtn.addEventListener('click', () => {
    deps.set(resetCalibration());
    for (const s of syncs) s();
    renderAnchors();
    refreshState();
    toast('Calibration reset to defaults');
  });
  sampleRow.append(resetBtn);
  anchorGroup.append(sampleRow);

  function renderAnchors() {
    const c = cal();
    table.replaceChildren(
      el('tr', {}, el('th', {}, 'Signal'), el('th', {}, 'Dry'), el('th', {}, 'Wet'), el('th', {}, 'Now')),
      ...SIGNAL_LABELS.map(([key, label]) => {
        const m = deps.metrics();
        const now = m ? toSignals(m.road)[key] : null;
        const dp = key === 'texture' ? 0 : 3;
        return el(
          'tr',
          {},
          el('td', {}, label),
          el('td', {}, c.dry[key].toFixed(dp)),
          el('td', {}, c.wet[key].toFixed(dp)),
          el('td', {}, now === null ? '—' : now.toFixed(dp)),
        );
      }),
    );
  }

  // ── Weights ──────────────────────────────────────────────────────────
  const weightGroup = el('div', { class: 'group' }, el('h4', {}, 'Signal weights'));
  for (const [key, label] of SIGNAL_LABELS) {
    const s = slider(label, 0, 1, 0.01, () => cal().weights[key], (v) => { cal().weights[key] = v; commit(); }, (v) => v.toFixed(2));
    syncs.push(s.sync);
    weightGroup.append(s.node);
  }
  weightGroup.append(
    el('p', { class: 'hint' }, 'Weights are renormalised on every frame, so the index always spans 0–100.'),
  );

  // ── Thresholds ───────────────────────────────────────────────────────
  const threshGroup = el('div', { class: 'group' }, el('h4', {}, 'Condition thresholds'));
  const threshFields: [string, number, number, number, keyof Calibration, (v: number) => string][] = [
    ['Damp above', 0, 100, 1, 'dampAt', (v) => v.toFixed(0)],
    ['Wet above', 0, 100, 1, 'wetAt', (v) => v.toFixed(0)],
    ['Drying divergence', 1, 40, 1, 'divergenceAt', (v) => `Δ ${v.toFixed(0)}`],
    ['Hysteresis margin', 0, 12, 0.5, 'hysteresis', (v) => v.toFixed(1)],
    ['Hold ticks', 1, 24, 1, 'holdTicks', (v) => `${v} ticks`],
    ['Smoothing', 0.02, 0.6, 0.01, 'smoothing', (v) => v.toFixed(2)],
  ];
  for (const [label, min, max, step, key, fmt] of threshFields) {
    const s = slider(label, min, max, step,
      () => cal()[key] as number,
      (v) => { (cal() as unknown as Record<string, number>)[key as string] = v; commit(); },
      fmt);
    syncs.push(s.sync);
    threshGroup.append(s.node);
  }

  // ── Glare detector ───────────────────────────────────────────────────
  const glareGroup = el('div', { class: 'group' }, el('h4', {}, 'Specular detector'));
  const gv = slider('Brightness floor', 0.3, 0.98, 0.01, () => cal().glareV, (v) => { cal().glareV = v; commit(); }, (v) => v.toFixed(2));
  const gs = slider('Saturation ceiling', 0.02, 0.6, 0.01, () => cal().glareS, (v) => { cal().glareS = v; commit(); }, (v) => v.toFixed(2));
  syncs.push(gv.sync, gs.sync);
  glareGroup.append(
    gv.node,
    gs.node,
    el('p', { class: 'hint' },
      'A pixel counts as specular when it is bright and near-colourless. Raise the floor if bright dry tarmac ' +
      'is being read as reflection; raise the ceiling if coloured reflections are being missed.'),
  );

  // ── ROI ──────────────────────────────────────────────────────────────
  const roiGroup = el('div', { class: 'group' }, el('h4', {}, 'Road ROI (perspective trapezoid)'));
  const roiFields: [string, keyof Calibration['road']][] = [
    ['Horizon (top)', 'yTop'],
    ['Bottom', 'yBot'],
    ['Top left', 'xTopL'],
    ['Top right', 'xTopR'],
    ['Bottom left', 'xBotL'],
    ['Bottom right', 'xBotR'],
  ];
  for (const [label, key] of roiFields) {
    const s = slider(label, 0, 1, 0.005,
      () => cal().road[key],
      (v) => { cal().road[key] = v; commit(); },
      (v) => v.toFixed(3));
    syncs.push(s.sync);
    roiGroup.append(s.node);
  }
  // Automatic tracing sits above the manual sliders because it is what runs by
  // default; the sliders below are the override for a camera it cannot read.
  const laneToggle = el('button', { class: 'btn' }, '') as HTMLButtonElement;
  const syncLane = () => {
    const on = cal().laneAuto;
    laneToggle.textContent = on ? 'Trace road automatically: on' : 'Trace road automatically: off';
    laneToggle.setAttribute('aria-pressed', String(on));
  };
  laneToggle.addEventListener('click', () => { cal().laneAuto = !cal().laneAuto; commit(); syncLane(); });
  syncs.push(syncLane);
  roiGroup.prepend(
    laneToggle,
    el('p', { class: 'hint' },
      'On, the road is found and followed every frame and only that surface is measured — ' +
      'the sliders below are ignored. Turn it off to aim the region by hand, which is the ' +
      'answer for a camera the tracer cannot read.'),
  );

  roiGroup.append(
    el('p', { class: 'hint' }, 'Keep the trapezoid on tarmac only. Sky, barriers and grass will poison every signal.'),
  );

  // ── AI verification ──────────────────────────────────────────────────
  const aiGroup = el('div', { class: 'group' }, el('h4', {}, 'AI verification'));
  const toggle = el('button', { class: 'btn' }, '') as HTMLButtonElement;
  const syncToggle = () => {
    const on = cal().aiEnabled;
    toggle.textContent = on ? 'Auto-verify: on' : 'Auto-verify: off';
    toggle.setAttribute('aria-pressed', String(on));
  };
  toggle.addEventListener('click', () => { cal().aiEnabled = !cal().aiEnabled; commit(); syncToggle(); });
  syncs.push(syncToggle);
  const interval = slider('Interval', 4, 60, 1, () => cal().aiIntervalSec, (v) => { cal().aiIntervalSec = v; commit(); }, (v) => `${v}s`);
  syncs.push(interval.sync);
  aiGroup.append(
    el('div', { class: 'row' }, toggle),
    interval.node,
    el('p', { class: 'hint' },
      'Verification runs off the render path and never blocks the readout. If the proxy is down, ' +
      'the CV engine carries on unaffected.'),
  );

  root.replaceChildren(anchorGroup, weightGroup, threshGroup, glareGroup, roiGroup, aiGroup);
  renderAnchors();
  syncToggle();

  function refreshState() {
    const c = cal();
    const d = DEFAULT_CALIBRATION;
    const custom =
      JSON.stringify(c.dry) !== JSON.stringify(d.dry) || JSON.stringify(c.wet) !== JSON.stringify(d.wet);
    state.textContent = custom ? 'calibrated' : 'defaults';
  }
  refreshState();

  return {
    refreshAnchors: renderAnchors,
    syncAll: () => { for (const s of syncs) s(); renderAnchors(); refreshState(); },
  };
}
