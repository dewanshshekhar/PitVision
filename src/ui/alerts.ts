import type { Condition, Reading } from '../types';
import type { Calibration } from '../cv/calibration';
import { el } from '../util/dom';
import { CONDITION_COLOUR } from './strip';

export type AlertKind = 'condition' | 'crossover' | 'surge' | 'ai' | 'system';
export type AlertLevel = 'info' | 'warn' | 'critical';

export interface Alert {
  t: number;
  kind: AlertKind;
  level: AlertLevel;
  title: string;
  detail: string;
  colour?: string;
}

/**
 * Trend is a least-squares slope, so it spikes hard the instant conditions
 * break. Past a point the exact figure stops carrying information and a
 * four-digit number just reads as a bug, so it is capped for display.
 */
function fmtTrend(perMin: number): string {
  const sign = perMin >= 0 ? '+' : '−';
  const mag = Math.abs(perMin);
  if (mag > 99) return `${sign}99+/min`;
  return `${sign}${mag.toFixed(1)}/min`;
}

const MAX_ALERTS = 60;
const SURGE_PER_MIN = 14;
/** A condition flip has to survive this long before it earns a ping. */
const SETTLE_MS = 1200;

/**
 * The pit-wall ping feed.
 *
 * A strategist is not watching the index — they are waiting to be told when
 * something changed. Every entry here is an event worth acting on, timestamped,
 * with the numbers that triggered it. Deliberately not a log of every frame.
 */
export class AlertFeed {
  readonly alerts: Alert[] = [];
  private list: HTMLElement;
  private counter: HTMLElement;
  private lastCondition: Condition | null = null;
  private pendingCondition: Condition | null = null;
  private pendingSince = 0;
  private surgeCooldown = 0;
  private mutedUntil = 0;
  private audio: AudioContext | null = null;

  soundOn = false;

  /**
   * Called for every ping. Lets the pings be recorded server-side without the
   * feed itself knowing anything about a backend — this class stays a UI
   * component that happens to be observable.
   */
  onPush: ((a: Alert) => void) | null = null;

  constructor(list: HTMLElement, counter: HTMLElement) {
    this.list = list;
    this.counter = counter;
    this.render();
  }

  push(a: Omit<Alert, 't'>) {
    const alert: Alert = { ...a, t: Date.now() };
    this.alerts.unshift(alert);
    if (this.alerts.length > MAX_ALERTS) this.alerts.pop();
    this.render();
    if (this.soundOn && a.level !== 'info') this.beep(a.level === 'critical' ? 880 : 620);
    this.onPush?.(alert);
  }

  clear() {
    this.alerts.length = 0;
    this.resetTracking();
    this.render();
  }

  private resetTracking() {
    this.lastCondition = null;
    this.pendingCondition = null;
    this.surgeCooldown = 0;
  }

  /**
   * Swallow pings for a moment and forget the previous state.
   *
   * Used when the clip loops: the jump from the end of the footage back to the
   * start is a discontinuity in the *recording*, not a change in the weather,
   * and pinging a strategist about it would be lying to them.
   */
  suppress(ms: number) {
    this.mutedUntil = Date.now() + ms;
    this.resetTracking();
  }

  /**
   * Called on every reading. Decides what, if anything, deserves a ping.
   *
   * Every event here keys off the classifier's committed label rather than a
   * second set of thresholds. An earlier version watched the divergence
   * directly and flapped: on a near-dry track a line of 1 against edges of 10
   * clears a 9-point gap and fired "dry line forming" over and over, while the
   * headline still read Dry. One source of truth, so the feed can never
   * contradict the readout.
   */
  observe(r: Reading, cal: Calibration) {
    const now = Date.now();
    if (now < this.mutedUntil) return;

    if (this.lastCondition === null) {
      this.lastCondition = r.condition;
      return;
    }
    if (r.condition === this.lastCondition) {
      this.pendingCondition = null;
    } else if (this.pendingCondition !== r.condition) {
      this.pendingCondition = r.condition;
      this.pendingSince = now;
    } else if (now - this.pendingSince >= SETTLE_MS) {
      const from = this.lastCondition;
      this.lastCondition = r.condition;
      this.pendingCondition = null;
      this.emitTransition(from, r);
    }

    // Rapid deterioration — worth interrupting for, and only while there is
    // enough water on the surface for the trend to mean anything.
    if (r.trend > SURGE_PER_MIN && r.wetness > cal.dampAt * 0.5 && now > this.surgeCooldown) {
      this.surgeCooldown = now + 20_000;
      this.push({
        kind: 'surge',
        level: 'critical',
        title: 'Rapid wetting',
        detail: `Index climbing ${fmtTrend(r.trend)}. Expect a compound change within a lap.`,
      });
    }
  }

  private emitTransition(from: Condition, r: Reading) {
    // The crossover gets its own ping with the numbers behind it — it is the
    // call that wins track position, not just another label change.
    if (r.condition === 'Drying') {
      this.push({
        kind: 'crossover',
        level: 'critical',
        title: 'Dry line forming',
        detail:
          `Racing line ${r.divergence.toFixed(0)} points drier than the edges ` +
          `(line ${r.line.toFixed(0)}, edges ${r.edge.toFixed(0)}). Crossover approaching.`,
        colour: CONDITION_COLOUR.Drying,
      });
      return;
    }
    if (from === 'Drying') {
      this.push({
        kind: 'crossover',
        level: r.condition === 'Dry' ? 'info' : 'warn',
        title: r.condition === 'Dry' ? 'Track fully dry' : `Dry line lost — ${r.condition}`,
        detail:
          r.condition === 'Dry'
            ? 'Surface uniform and dry across the full width. Slicks everywhere.'
            : `Divergence closed to ${r.divergence.toFixed(0)}. The line is taking water again.`,
        colour: CONDITION_COLOUR[r.condition],
      });
      return;
    }
    this.push({
      kind: 'condition',
      level: r.condition === 'Wet' ? 'critical' : 'warn',
      title: `${from} → ${r.condition}`,
      detail: `Wetness index ${r.wetness.toFixed(0)}, trend ${fmtTrend(r.trend)}.`,
      colour: CONDITION_COLOUR[r.condition],
    });
  }

  private beep(freq: number) {
    try {
      this.audio ??= new AudioContext();
      const ctx = this.audio;
      if (ctx.state === 'suspended') void ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.14, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.24);
    } catch {
      /* audio blocked until a gesture — not worth surfacing */
    }
  }

  private render() {
    this.counter.textContent = this.alerts.length ? `${this.alerts.length}` : '—';
    if (this.alerts.length === 0) {
      this.list.replaceChildren(
        el('p', { class: 'hint' }, 'No events yet. Pings appear here the moment the surface changes.'),
      );
      return;
    }
    this.list.replaceChildren(
      ...this.alerts.map((a) => {
        const time = new Date(a.t).toLocaleTimeString(undefined, { hour12: false });
        const node = el(
          'div',
          { class: `alert alert-${a.level}` },
          el('span', { class: 'alert-time' }, time),
          el(
            'div',
            { class: 'alert-body' },
            el('div', { class: 'alert-title' }, a.title),
            el('div', { class: 'alert-detail' }, a.detail),
          ),
        );
        if (a.colour) node.style.setProperty('--alert-accent', a.colour);
        return node;
      }),
    );
  }
}
