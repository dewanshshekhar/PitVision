import './styles/app.css';

import type { FrameMetrics, Reading, Signals } from './types';
import { CvEngine } from './cv/engine';
import { loadCalibration, saveCalibration, type Calibration } from './cv/calibration';
import { SourceManager } from './source/manager';
import { SCENARIO_LENGTH } from './source/synthetic';
import { suggest } from './strategy/suggest';
import { Verifier } from './ai/verify';
import { runPreRaceCheck, type Check } from './cv/prerace';
import { AlertFeed } from './ui/alerts';
import { Overlay } from './ui/overlay';
import { TrendChart } from './ui/trend';
import { ConditionStrip, CONDITION_COLOUR } from './ui/strip';
import { ParticleField } from './ui/particles';
import { buildCalibrationPanel } from './ui/panels';
import { estimateLap, formatLap, formatDelta } from './strategy/lapdelta';
import { loadEntrant, saveEntrant, renderEntrant, type Entrant } from './ui/entrant';
import { Telemetry } from './telemetry/client';
import { $, el, toast } from './util/dom';

// ── State ──────────────────────────────────────────────────────────────
let cal: Calibration = loadCalibration();

const source = new SourceManager();
// 20 Hz for the timer-driven fallback, so worst-case staleness on a source
// without frame callbacks stays around 60 ms rather than 95 ms.
const engine = new CvEngine(source, cal, { sampleWidth: 384, hz: 20 });
const verifier = new Verifier();
// Recording is additive: if the backend is unreachable every call here is a
// no-op and the detector runs exactly as it did before.
const telemetry = new Telemetry();

const stage = $('#stage');
const overlay = new Overlay($<HTMLCanvasElement>('#overlay'));
const particles = new ParticleField($<HTMLCanvasElement>('#particles'));
const chart = new TrendChart($<HTMLCanvasElement>('#trend'));
const strip = new ConditionStrip($<HTMLCanvasElement>('#strip'));

const alerts = new AlertFeed($('#alert-list'), $('#alert-count'));
let effectsWanted = false;

/** Accepts "1:32.5", "92.5" or "1:32.500". Returns seconds, or 0 if unparseable. */
function parseLapTime(text: string): number {
  const t = text.trim();
  const mmss = /^(\d+):([0-5]?\d(?:\.\d+)?)$/.exec(t);
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
  const secs = Number(t);
  return Number.isFinite(secs) && secs > 0 ? secs : 0;
}

let baselineLap = 92.5;
const baselineInput = $<HTMLInputElement>('#baseline-input');
baselineInput.addEventListener('change', () => {
  const parsed = parseLapTime(baselineInput.value);
  if (parsed > 0) {
    baselineLap = parsed;
    toast(`Dry baseline set to ${formatLap(baselineLap)}`);
  } else {
    baselineInput.value = formatLap(baselineLap);
    toast('Enter a lap time like 1:32.500');
  }
});

// ── Theme ──────────────────────────────────────────────────────────────
const THEME_KEY = 'pitvision.theme';
function applyTheme(theme: 'dark' | 'light') {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* private mode */
  }
}
applyTheme((localStorage.getItem(THEME_KEY) as 'dark' | 'light' | null) ?? 'dark');
$('#btn-theme').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
});

// ── Entrant identity bar ───────────────────────────────────────────────
let entrant: Entrant = loadEntrant();
const entrantRoot = $('#entrant');

function showEntrant() {
  renderEntrant(entrantRoot, entrant, openEntrantForm);
}

function openEntrantForm() {
  const fields: [keyof Entrant, string, string][] = [
    ['driver', 'Driver', 'text'],
    ['number', 'Number', 'text'],
    ['team', 'Team', 'text'],
    ['car', 'Car', 'text'],
    ['circuit', 'Circuit', 'text'],
    ['session', 'Session', 'text'],
    ['colour', 'Team colour', 'color'],
  ];
  const form = el('div', { class: 'entrant-form' });
  const inputs = new Map<keyof Entrant, HTMLInputElement>();
  for (const [key, label, type] of fields) {
    const input = el('input', { type, value: String(entrant[key] ?? '') }) as HTMLInputElement;
    inputs.set(key, input);
    form.append(el('label', {}, label, input));
  }

  const file = el('input', { type: 'file', accept: 'image/*' }) as HTMLInputElement;
  form.append(el('label', {}, 'Driver photo (from your own files)', file));

  const save = el('button', { class: 'btn primary' }, 'Save');
  const cancel = el('button', { class: 'btn ghost' }, 'Cancel');
  form.append(el('div', { class: 'row' }, save, cancel));

  save.addEventListener('click', () => {
    for (const [key, input] of inputs) {
      (entrant as unknown as Record<string, string>)[key as string] = input.value;
    }
    const picked = file.files?.[0];
    if (picked) {
      if (entrant.portrait) URL.revokeObjectURL(entrant.portrait);
      entrant.portrait = URL.createObjectURL(picked);
    }
    saveEntrant(entrant);
    showEntrant();
    toast('Entrant updated');
  });
  cancel.addEventListener('click', showEntrant);

  entrantRoot.replaceChildren(form);
}

showEntrant();

// ── Feed element mounting ──────────────────────────────────────────────
function mountFeed() {
  const existing = stage.querySelector('video, canvas.feed');
  if (existing) existing.remove();
  const node = source.displayElement;
  if (node) {
    node.classList.add('feed');
    if (node instanceof HTMLVideoElement) {
      node.classList.remove('feed');
      node.setAttribute('playsinline', '');
    }
    stage.prepend(node);
  }
  $('#source-label').textContent = source.label;
  $('#btn-synthetic').setAttribute('aria-pressed', String(source.usingSynthetic));
  $('#hud-phase').hidden = !source.usingSynthetic;
  $('#stage-empty').hidden = source.kind !== 'none';

  // Ambient rain/shimmer is a styling layer for the generated scene. Painted
  // over real footage it is just clutter on top of the evidence, so it is off
  // unless explicitly asked for.
  particles.enabled = source.usingSynthetic && effectsWanted;
  syncCalibrationBanner();
}

/** True when the loaded feed is not the one the current anchors were measured on. */
function calibrationIsStale() {
  return source.kind !== 'none' && cal.signature !== source.signature;
}

function syncCalibrationBanner() {
  const stale = calibrationIsStale();
  $('#pill-calib').hidden = !stale;
  document.documentElement.classList.toggle('uncalibrated', stale);
}
source.onChange(mountFeed);
mountFeed();

// A looping clip jumps from the end of the footage back to the start. The
// smoothing and trend windows would read that as a violent weather swing, so
// the session is cut cleanly at the boundary instead.
source.onLoopRestart(() => {
  engine.resetSmoothing();
  alerts.suppress(1500);
  alerts.push({
    kind: 'system',
    level: 'info',
    title: 'Clip looped',
    detail: 'Feed restarted from the top. Trend and smoothing reset at the boundary.',
  });
});

// ── Signal breakdown rows ──────────────────────────────────────────────
const SIGNAL_ROWS: [keyof Signals, string][] = [
  ['glare', 'Specular glare'],
  ['texture', 'Texture loss'],
  ['darkness', 'Darkness'],
  ['specular', 'Highlight spread'],
];
const signalBars = new Map<keyof Signals, { fill: HTMLElement; val: HTMLElement }>();
{
  const host = $('#signals');
  for (const [key, label] of SIGNAL_ROWS) {
    const fill = el('i');
    const val = el('div', { class: 'v' }, '—');
    host.append(
      el('div', { class: 'sig' },
        el('div', { class: 'n' }, label),
        el('div', { class: 'track' }, fill),
        val),
    );
    signalBars.set(key, { fill, val });
  }
}

// ── Readout ────────────────────────────────────────────────────────────
const ui = {
  condition: $('#out-condition'),
  index: $('#out-index'),
  gauge: $('#out-gauge'),
  trend: $('#out-trend'),
  trendArrow: $('#out-trend-arrow'),
  line: $('#out-line'),
  edge: $('#out-edge'),
  divBar: $('#out-div-bar'),
  divNote: $('#out-div-note'),
  tyre: $('#out-tyre'),
  call: $('#out-call'),
  detail: $('#out-detail'),
  urgency: $('#out-urgency'),
  hudCondition: $('#hud-condition'),
  hudIndex: $('#hud-index'),
  hudLine: $('#hud-line'),
  hudEdge: $('#hud-edge'),
  hudDiv: $('#hud-div'),
  hudPhase: $('#hud-phase'),
  engineRate: $('#engine-rate'),
  engineLatency: $('#engine-latency'),
  engineDot: $('#dot-engine'),
  trendRate: $('#trend-rate'),
};

let lastReading: Reading | null = null;
let ticksThisSecond = 0;
let rateWindow = performance.now();

function applyReading(r: Reading, _m: FrameMetrics) {
  const previousCondition = lastReading?.condition;
  lastReading = r;
  ticksThisSecond++;
  alerts.observe(r, cal);
  const laneStatus = engine.laneStatus;
  telemetry.setLane(
    cal.laneAuto ? laneStatus.state : 'manual',
    laneStatus.trace?.confidence ?? 0,
  );
  telemetry.observe(r, r.endToEndMs);
  syncLanePill();
  // A condition change is what a second screen is waiting for, so it goes out
  // now rather than on the next flush.
  if (previousCondition && previousCondition !== r.condition) telemetry.observeConditionChange();

  const lap = estimateLap(baselineLap, r.condition);
  $('#lap-projected').textContent = formatLap(lap.seconds);
  $('#lap-range').textContent = `${formatLap(lap.low)} – ${formatLap(lap.high)}`;
  $('#lap-delta').textContent = formatDelta(lap.delta);
  $('#lap-deltarange').textContent = `${formatDelta(lap.deltaLow)} – ${formatDelta(lap.deltaHigh)}`;
  $('#lap-tyre').textContent = lap.model.tyre;
  $('#lap-note').textContent = lap.model.note;

  document.documentElement.dataset.condition = r.condition;

  const idx = Math.round(r.wetness);
  // Re-trigger the entrance animation only on an actual change, so the readout
  // is calm while the state holds and unmistakable when it moves.
  if (ui.condition.textContent !== r.condition) {
    ui.condition.classList.remove('flip');
    void ui.condition.offsetWidth;
    ui.condition.classList.add('flip');
    ui.tyre.classList.remove('flip');
    void ui.tyre.offsetWidth;
    ui.tyre.classList.add('flip');
  }
  ui.condition.textContent = r.condition;
  ui.index.innerHTML = `${idx}<small>/100</small>`;
  ui.gauge.style.width = `${r.wetness.toFixed(1)}%`;
  ui.line.textContent = String(Math.round(r.line));
  ui.edge.textContent = String(Math.round(r.edge));

  // Trend is a least-squares slope, so it spikes hard the instant conditions
  // break. Past a point the exact figure carries no information and a
  // four-digit number just reads as a bug, so it is capped for display.
  const trend = r.trend;
  const trendMag = Math.abs(trend);
  ui.trend.textContent =
    trendMag > 99 ? `${trend >= 0 ? '+' : '−'}99+` : `${trend >= 0 ? '+' : ''}${trend.toFixed(1)}`;
  ui.trendArrow.textContent = trend > 2.5 ? '↑' : trend < -2.5 ? '↓' : '→';
  ui.trendRate.textContent = `${trend >= 0 ? '+' : ''}${trend.toFixed(1)} / min`;

  ui.hudCondition.textContent = r.condition;
  ui.hudIndex.textContent = String(idx);
  ui.hudLine.textContent = String(Math.round(r.line));
  ui.hudEdge.textContent = String(Math.round(r.edge));
  ui.hudDiv.textContent = `${r.divergence >= 0 ? '+' : ''}${r.divergence.toFixed(0)}`;

  // Divergence bar: centre = no difference, right = line drier than edges.
  const clamped = Math.max(-30, Math.min(30, r.divergence));
  const half = Math.abs(clamped) / 60;
  ui.divBar.style.left = clamped >= 0 ? '50%' : `${(0.5 - half) * 100}%`;
  ui.divBar.style.width = `${half * 100}%`;
  ui.divBar.style.background = clamped >= 0 ? 'var(--drying)' : 'var(--damp)';
  if (!cal.divergenceReliable) {
    // Say why the number is not being acted on, rather than showing a figure
    // that looks like a dry line but is really the camera angle.
    ui.divBar.style.width = '0%';
    ui.divNote.textContent =
      'Unavailable on this camera angle — the edge bands are not on the track surface. ' +
      'Wetness detection is unaffected.';
  } else {
    ui.divNote.textContent =
      r.divergence >= cal.divergenceAt
        ? `Racing line is ${r.divergence.toFixed(0)} points drier than the edges — a dry line is forming.`
        : r.divergence <= -cal.divergenceAt
          ? `Edges reading drier than the line — check the ROI placement.`
          : 'Surface uniform across the width.';
  }

  for (const [key, bar] of signalBars) {
    const n = r.normalised[key];
    bar.fill.style.width = `${(n * 100).toFixed(1)}%`;
    bar.val.textContent = n.toFixed(2);
  }

  const s = suggest(r);
  ui.tyre.textContent = s.tyre === 'Intermediate' ? 'INT' : s.tyre === 'Full wet' ? 'WET' : s.tyre === 'Slicks' ? 'SLK' : '—';
  ui.call.textContent = s.call;
  ui.detail.textContent = s.detail;
  ui.urgency.textContent = s.urgency;
  ui.urgency.dataset.u = s.urgency;
}

engine.onReading(applyReading);

// ── Render loop ────────────────────────────────────────────────────────
let lastPaint = 0;
let lastFrameAt = 0;
function frame(t: number) {
  requestAnimationFrame(frame);
  lastFrameAt = performance.now();
  source.pump();

  // Draw the region the detector actually measured, not the one in the
  // calibration — with tracing on, those are different shapes.
  overlay.corridor = engine.lastCorridor;
  overlay.draw(engine.lastMetrics, cal, source.width, source.height);
  particles.draw(lastReading?.wetness ?? 0);

  if (source.usingSynthetic) {
    const scene = source.synthetic;
    ui.hudPhase.innerHTML = `scene <b>${scene.phase}</b> · ${(scene.time % SCENARIO_LENGTH).toFixed(0)}s`;
  }

  if (t - lastPaint > 120) {
    lastPaint = t;
    const accent = CONDITION_COLOUR[lastReading?.condition ?? 'Dry'];
    chart.draw(engine.history, cal, accent);
    strip.draw(engine.history);
  }
}

// Engine telemetry is a property of the pipeline, not of the paint loop, so it
// reports on its own timer — the rate badge stays truthful even if rendering
// stalls, which is exactly when you would want to see it.
window.setInterval(() => {
  const now = performance.now();
  const elapsed = now - rateWindow;
  if (elapsed < 500) return;
  const hz = (ticksThisSecond * 1000) / elapsed;
  ui.engineRate.textContent = `${hz.toFixed(0)} Hz`;

  // Report the p95 of the full path, not the mean of the arithmetic. A mean
  // hides exactly the stalls a strategist would notice.
  // With no frame-driven samples yet there is nothing honest to report — a
  // paused feed showing "0 ms" would read as a suspiciously perfect result.
  const p95 = engine.p95EndToEndMs;
  ui.engineLatency.textContent = p95 > 0 ? `${p95.toFixed(0)} ms p95` : '—';
  $('#pill-latency').classList.toggle('over-budget', p95 > 100);
  ui.engineDot.className = `dot ${hz > 4 ? 'live' : 'warnState'}`;
  ticksThisSecond = 0;
  rateWindow = now;
}, 1000);
requestAnimationFrame(frame);

// Normally the paint loop advances the generated feed at display rate. If the
// page stops painting — backgrounded tab, hidden window — the engine takes over
// advancing it, so detection carries on at a true 12 Hz instead of freezing.
engine.beforeTick = () => {
  if (performance.now() - lastFrameAt > 100) source.pump();
};
engine.start();

// Exposed for calibration work and for poking at the pipeline from the console.
Object.assign(window, {
  pitvision: {
    engine, source, verifier, overlay, chart, strip, particles, alerts,
    get cal() { return cal; },
    /** Force a repaint of every canvas layer. */
    repaint() {
      // Draw the region the detector actually measured, not the one in the
  // calibration — with tracing on, those are different shapes.
  overlay.corridor = engine.lastCorridor;
  overlay.draw(engine.lastMetrics, cal, source.width, source.height);
      particles.draw(engine.lastReading?.wetness ?? 0);
      chart.draw(engine.history, cal, CONDITION_COLOUR[engine.lastReading?.condition ?? 'Dry']);
      strip.draw(engine.history);
    },
  },
});

// ── Session recording ──────────────────────────────────────────────────
//
// The session is scoped to one feed. Loading a different clip closes the
// previous session rather than continuing it: the calibration anchors change
// with the footage, and a series scored against two sets of anchors is not one
// series.

const sessionPill = $('#pill-session');
const sessionLabel = $('#session-label');

// ── Lane trace state ───────────────────────────────────────────────────
//
// The corridor the detector measures through is found automatically and can
// fail to find anything — a camera on the pit garage, a feed that has cut to a
// studio shot. That has to be visible, because the alternative is a readout
// that looks identical whether it is measuring tarmac or a wall.
const lanePill = $('#pill-lane');
const laneLabel = $('#lane-label');

function syncLanePill() {
  if (!cal.laneAuto) {
    lanePill.className = 'pill';
    lanePill.title = 'Automatic tracing off — measuring through the hand-placed ROI';
    laneLabel.textContent = 'manual';
    return;
  }
  const seg = engine.segmenter.state;
  if (engine.lastCorridorSource === 'segmentation' && seg.state === 'live') {
    lanePill.className = 'pill';
    lanePill.title = `${seg.message} · ${seg.latencyMs} ms round trip`;
    laneLabel.textContent = 'segmented';
    return;
  }

  const { state, trace, lastCostMs } = engine.laneStatus;
  if (state === 'locked' && trace) {
    lanePill.className = 'pill';
    lanePill.title =
      `Road traced: ${(trace.meanWidth * 100).toFixed(0)}% of frame width, ` +
      `${(trace.confidence * 100).toFixed(0)}% of rows measured, ${lastCostMs.toFixed(2)} ms per trace`;
    laneLabel.textContent = `traced ${(trace.confidence * 100).toFixed(0)}%`;
  } else {
    lanePill.className = 'pill warn-pill';
    lanePill.title =
      state === 'lost'
        ? 'Lost the road — measuring through the last known region. Check the overlay.'
        : 'Looking for the road surface.';
    laneLabel.textContent = state === 'lost' ? 'lost' : 'searching';
  }
}

telemetry.onChange((s) => {
  sessionPill.hidden = s.status === 'off' && !s.sessionId;
  sessionPill.className = `pill${s.status === 'retrying' ? ' warn-pill' : ''}`;
  sessionPill.title = s.message;
  sessionLabel.textContent =
    s.status === 'live'
      ? `rec ${s.sent}`
      : s.status === 'retrying'
        ? `queued ${s.queued}`
        : s.status === 'connecting'
          ? 'opening…'
          : 'off';
});

alerts.onPush = (a) => telemetry.event(a);

// The backend watches the detector while it runs. What it finds has to arrive
// where the strategist is already looking, or the watching was pointless.
telemetry.onIncident = (incident, state) => {
  if (state === 'closed') {
    alerts.push({
      kind: 'monitor',
      level: 'info',
      title: `Cleared — ${incident.summary}`,
      detail: `Held for ${(((incident.closed_at ?? Date.now()) - incident.opened_at) / 1000).toFixed(0)}s.`,
    });
    return;
  }
  alerts.push({
    kind: 'monitor',
    level: incident.severity === 'critical' ? 'critical' : 'warn',
    title: incident.summary,
    detail: incident.detail ?? 'Raised by the backend monitor.',
  });
};

/** Open a recording session for whatever feed is now loaded. */
async function startRecording() {
  if (source.kind === 'none') return;
  const id = await telemetry.start({
    kind: source.kind,
    label: source.label,
    signature: source.signature,
    entrant,
    baselineLapS: baselineLap,
  });
  verifier.sessionId = id;
  if (id) toast(`Recording session ${id.slice(0, 12)}`);
}

// The tab going away must close the session, or its report would carry the
// server's whole idle timeout as silence on the end.
window.addEventListener('pagehide', () => telemetry.endOnUnload());

// ── AI verification ────────────────────────────────────────────────────
const verifyUi = {
  status: $('#verify-status'),
  verdict: $('#verify-verdict'),
  reasoning: $('#verify-reasoning'),
  meta: $('#verify-meta'),
  button: $<HTMLButtonElement>('#btn-verify'),
};

verifier.onChange((s) => {
  verifyUi.status.textContent = s.status === 'ok' ? 'verified' : s.status;
  verifyUi.button.disabled = s.status === 'checking';
  verifyUi.button.textContent = s.status === 'checking' ? 'Checking…' : 'Verify now';

  if (s.status === 'offline' || s.status === 'error') {
    verifyUi.verdict.className = 'tag disagree';
    verifyUi.verdict.textContent = s.status === 'offline' ? 'offline' : 'error';
    verifyUi.meta.textContent = s.message;
    return;
  }
  if (!s.last) {
    verifyUi.meta.textContent = s.message;
    return;
  }
  const v = s.last;
  verifyUi.verdict.className = `tag ${v.agrees ? 'agree' : 'disagree'}`;
  verifyUi.verdict.textContent = v.agrees
    ? `agrees — ${v.condition}`
    : `flags for review — reads ${v.condition}`;
  verifyUi.reasoning.textContent = v.reasoning;
  verifyUi.meta.textContent =
    `${v.model ?? 'model'} · confidence ${(v.confidence * 100).toFixed(0)}% · ` +
    `${v.latencyMs ?? 0} ms · CV said ${v.cvCondition} · ${new Date(v.at).toLocaleTimeString()}`;
});

async function runVerification(manual = false) {
  if (!lastReading) {
    if (manual) toast('No reading to verify yet');
    return;
  }
  const shot = engine.snapshot();
  if (!shot) {
    if (manual) toast('Could not capture a frame');
    return;
  }
  await verifier.verify(shot, lastReading);
}

verifyUi.button.addEventListener('click', () => {
  // A manual trigger also re-arms auto-verification, so adding a key to the
  // proxy mid-session recovers without a reload.
  verifier.clearAvailability();
  void runVerification(true);
});

window.setInterval(() => {
  if (!cal.aiEnabled || verifier.busy || !verifier.available) return;
  if (Date.now() - verifier.lastRunAt < cal.aiIntervalSec * 1000) return;
  void runVerification();
}, 1000);

void verifier.health();

// ── Pre-race check ─────────────────────────────────────────────────────
const MARKS: Record<Check['state'], string> = {
  pending: '·', running: '◌', pass: '✓', warn: '!', fail: '✕',
};

function renderChecks(checks: Check[]) {
  $('#prerace-list').replaceChildren(
    ...checks.map((c) =>
      el('div', { class: 'check', 'data-s': c.state },
        el('span', { class: 'mark' }, MARKS[c.state]),
        el('div', {},
          el('div', { class: 'k' }, c.label),
          el('div', { class: 'd' }, c.detail)))),
  );
}

let checkRunning = false;

async function preRace(calibrate = true) {
  if (checkRunning) return;
  if (!source.ready) {
    toast('Load footage first');
    return;
  }
  checkRunning = true;
  const btn = $<HTMLButtonElement>('#btn-prerace');
  const btn2 = $<HTMLButtonElement>('#btn-recalib');
  btn.disabled = btn2.disabled = true;
  const verdict = $('#prerace-verdict');
  verdict.className = 'tag';
  verdict.textContent = 'running…';

  // The engine must stand still while the check seeks around the clip,
  // otherwise it records the scan itself as a wild condition swing.
  engine.stop();
  source.seeking = true;
  try {
    const result = await runPreRaceCheck(source, engine, cal, renderChecks, {
      calibrate,
      // A live feed hands back usable anchors early and keeps refining them
      // behind the session. Each refinement is applied as it arrives, so the
      // scale tightens under a readout that never stopped.
      onLiveRefine: (refined) => {
        cal = refined;
        engine.setCalibration(cal);
        saveCalibration(cal);
        calPanel.syncAll();
        syncCalibrationBanner();
      },
    });
    if (result.calibration) {
      cal = result.calibration;
      engine.setCalibration(cal);
      saveCalibration(cal);
      calPanel.syncAll();
      syncCalibrationBanner();
    }
    const worst = result.checks.some((c) => c.state === 'fail')
      ? 'fail'
      : result.checks.some((c) => c.state === 'warn')
        ? 'warn'
        : 'pass';
    verdict.className = `tag ${worst}`;
    verdict.textContent = worst === 'pass' ? 'ready' : worst === 'warn' ? 'ready, with notes' : 'not ready';
    // Store the anchors alongside the outcome. A disputed reading is almost
    // always a disputed calibration, and without them a recorded wetness of 62
    // is a number with no units.
    void telemetry.calibration({
      ok: worst !== 'fail',
      checks: result.checks,
      verdict: worst,
      anchoring: result.report?.branch ?? null,
      cal,
      signature: source.signature,
    });
    alerts.push({
      kind: 'system',
      level: worst === 'fail' ? 'critical' : 'info',
      title: worst === 'fail' ? 'Pre-race check failed' : 'Pre-race check complete',
      detail: result.report
        ? result.report.note
        : result.checks.find((c) => c.state === 'fail')?.detail ?? 'Pipeline warm and inside budget.',
    });
  } finally {
    source.seeking = false;
    engine.clearHistory();
    alerts.suppress(1200);
    engine.start();
    checkRunning = false;
    btn.disabled = btn2.disabled = false;
  }
}

$('#btn-prerace').addEventListener('click', () => void preRace(true));
$('#btn-recalib').addEventListener('click', () => void preRace(true));

// ── Controls ───────────────────────────────────────────────────────────
const btnPlay = $<HTMLButtonElement>('#btn-play');
btnPlay.addEventListener('click', () => {
  const playing = source.togglePlay();
  btnPlay.textContent = playing ? 'Pause' : 'Play';
  btnPlay.setAttribute('aria-pressed', String(playing));
});

function syncPlayButton() {
  btnPlay.textContent = source.playing ? 'Pause' : 'Play';
  btnPlay.setAttribute('aria-pressed', String(source.playing));
}

function useGeneratedScene(view: 'onboard' | 'trackside' = 'onboard') {
  source.synthetic.view = view;
  source.useSynthetic();
  engine.resetSmoothing();
  engine.clearHistory();
  alerts.clear();
  syncPlayButton();
  void startRecording();
  $('#btn-synthetic').setAttribute('aria-pressed', String(view === 'onboard'));
  $('#btn-trackside').setAttribute('aria-pressed', String(view === 'trackside'));
  toast(
    view === 'trackside'
      ? 'Trackside camera — fixed view, cars passing. Dry-line detection works here.'
      : 'Onboard scene — a stand-in until footage is loaded',
  );
}

$('#btn-synthetic').addEventListener('click', () => useGeneratedScene('onboard'));
$('#btn-trackside').addEventListener('click', () => useGeneratedScene('trackside'));
$('#btn-demo').addEventListener('click', () => useGeneratedScene('trackside'));

/** Load a clip, then immediately run the pre-race check against it. */
async function adoptFootage(load: () => Promise<void>, name: string) {
  try {
    await load();
    engine.resetSmoothing();
    engine.clearHistory();
    alerts.clear();
    syncPlayButton();
    toast(`${name} loaded — running pre-race check`);
    // Before the check, so its outcome and anchors land in this session
    // rather than in whatever was open beforehand.
    await startRecording();
    await preRace(true);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  }
}

$<HTMLInputElement>('#file-input').addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) void adoptFootage(() => source.useFile(file), file.name);
});

$('#btn-camera').addEventListener('click', () => {
  void adoptFootage(() => source.useCamera(), 'Camera');
});

$('#btn-screen').addEventListener('click', () => {
  void adoptFootage(() => source.useScreen(), 'Screen capture');
});

$('#btn-url').addEventListener('click', () => {
  const url = $<HTMLInputElement>('#url-input').value.trim();
  if (!url) return;
  void adoptFootage(() => source.useUrl(url), url.split('/').pop() || url);
});

// ── ROI editing ────────────────────────────────────────────────────────
overlay.attachEditing(() => cal);
overlay.onRoadChange = (road) => {
  cal = { ...cal, road };
  engine.setCalibration(cal);
  saveCalibration(cal);
  calPanel.syncAll();
};

const btnEffects = $('#btn-effects');
btnEffects.addEventListener('click', () => {
  effectsWanted = !effectsWanted;
  btnEffects.setAttribute('aria-pressed', String(effectsWanted));
  particles.enabled = source.usingSynthetic && effectsWanted;
  if (!particles.enabled) particles.draw(0);
  toast(effectsWanted ? 'Ambient effects on (generated scene only)' : 'Ambient effects off');
});

const btnEdit = $('#btn-edit-roi');
btnEdit.addEventListener('click', () => {
  overlay.editing = !overlay.editing;
  btnEdit.setAttribute('aria-pressed', String(overlay.editing));
  stage.classList.toggle('editing', overlay.editing);
  toast(overlay.editing ? 'Drag the four corners onto the tarmac' : 'ROI locked');
});

// ── Ping sound ─────────────────────────────────────────────────────────
const btnSound = $('#btn-sound');
btnSound.addEventListener('click', () => {
  alerts.soundOn = !alerts.soundOn;
  btnSound.setAttribute('aria-pressed', String(alerts.soundOn));
  btnSound.textContent = alerts.soundOn ? 'Sound on' : 'Sound off';
});

const btnOverlay = $('#btn-overlay');
btnOverlay.addEventListener('click', () => {
  overlay.showRois = !overlay.showRois;
  btnOverlay.setAttribute('aria-pressed', String(overlay.showRois));
});

const btnHeat = $('#btn-heat');
btnHeat.addEventListener('click', () => {
  overlay.showHeat = !overlay.showHeat;
  btnHeat.setAttribute('aria-pressed', String(overlay.showHeat));
});

// Drag & drop a clip straight onto the stage.
stage.addEventListener('dragover', (e) => {
  e.preventDefault();
  stage.style.outline = '2px dashed var(--accent)';
});
stage.addEventListener('dragleave', () => { stage.style.outline = 'none'; });
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  stage.style.outline = 'none';
  const file = e.dataTransfer?.files?.[0];
  if (file?.type.startsWith('video/')) {
    void adoptFootage(() => source.useFile(file), file.name);
  } else {
    toast('Drop a video file');
  }
});

// ── Calibration panel ──────────────────────────────────────────────────
const calPanel = buildCalibrationPanel($('#cal-body'), $('#cal-state'), {
  get: () => cal,
  set: (next) => {
    cal = next;
    engine.setCalibration(cal);
    saveCalibration(cal);
  },
  metrics: () => engine.lastMetrics,
  holdScene: (wetness) => {
    const s = source.synthetic;
    if (wetness === null) {
      s.manual = false;
    } else {
      s.manual = true;
      s.edgeWet = wetness;
      s.lineWet = wetness;
      s.rain = wetness > 0.5 ? 0.8 : 0;
    }
  },
  sceneLive: () => source.usingSynthetic,
});

// Keep the panel's "now" column live without re-rendering it every frame.
window.setInterval(() => {
  const panel = document.getElementById('cal-panel') as HTMLDetailsElement | null;
  if (panel?.open) calPanel.refreshAnchors();
}, 700);

// ── Keyboard shortcuts (demo ergonomics) ───────────────────────────────
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === ' ') { e.preventDefault(); btnPlay.click(); }
  if (e.key === 'v') void runVerification(true);
  if (e.key === 'o') btnOverlay.click();
  if (e.key === 'h') btnHeat.click();
});
