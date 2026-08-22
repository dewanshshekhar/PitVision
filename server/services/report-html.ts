/**
 * The session report, as a page.
 *
 * The JSON at `/report` is for machines. This is the same numbers for the
 * person who was not in the garage: open a URL after the session and read what
 * the track did, whether the detector could be trusted while it did it, and
 * what that cost.
 *
 * Rendered server-side and fully self-contained — no build step, no scripts, no
 * external requests. A debrief happens on whatever laptop is in the room, often
 * without a network, and a report that needs a CDN to render is not a report.
 */

import type { SessionReport, Segment } from './report.ts';
import type { Condition } from '../domain/conditions.ts';

/** The palette the live UI uses, so a segment is the colour it was on screen. */
const COLOUR: Record<Condition, string> = {
  Sunny: '#ffd34d',
  Dry: '#ffb020',
  Greasy: '#c9d152',
  Drying: '#46e08a',
  Damp: '#38bdf8',
  Wet: '#4f7cff',
  Flooded: '#7b5cff',
};

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clock(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
}

function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

/**
 * The condition timeline as one proportional bar.
 *
 * Proportional to *time*, not to sample count: a stretch where the feed dropped
 * frames would otherwise shrink on the page exactly when it most deserves
 * attention.
 */
function timelineBar(timeline: Segment[], totalMs: number): string {
  if (timeline.length === 0 || totalMs <= 0) {
    return '<p class="muted">No readings — nothing to plot.</p>';
  }
  const cells = timeline
    .map((seg) => {
      const pct = Math.max(0.4, (seg.durationMs / totalMs) * 100);
      const title =
        `${seg.condition} · ${duration(seg.durationMs)} · ` +
        `${clock(seg.from)}–${clock(seg.to)} · peak ${seg.peakWetness}`;
      return `<i style="flex:${pct};background:${COLOUR[seg.condition] ?? '#888'}" title="${esc(title)}"></i>`;
    })
    .join('');
  return `<div class="timeline">${cells}</div>`;
}

function stat(label: string, value: string, note = ''): string {
  return `<div class="stat"><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div>${
    note ? `<div class="n">${esc(note)}</div>` : ''
  }</div>`;
}

export function renderReport(r: SessionReport): string {
  const e = r.session.entrant;
  const who = [e.driver, e.number ? `#${e.number}` : '', e.team, e.car].filter(Boolean).join(' · ');
  const where = [e.circuit, e.session].filter(Boolean).join(' — ');

  // ── Verification ────────────────────────────────────────────────────
  //
  // The distinction that matters is between "the detector was checked and
  // agreed with" and "nothing was checking it". Reporting 0% for the second
  // would read as a failing detector rather than an absent auditor.
  const v = r.verification;
  const verificationBlock =
    v.attempts === 0
      ? `<p class="warn-note">No AI verification ran during this session. The detector was
         unchecked — that is not the same as it having been correct.</p>`
      : v.comparable === 0
        ? `<p class="warn-note">${v.attempts} verification call(s) ran but produced no comparable
           verdict${v.failed ? ` (${v.failed} failed)` : ''}. Nothing here confirms the detector.</p>`
        : `<div class="stats">
             ${stat('Agreement', `${v.agreementRate}%`, `over ${v.comparable} comparable checks`)}
             ${stat('Exact match', String(v.matches))}
             ${stat('Adjacent band', String(v.adjacent), 'counted as half agreement')}
             ${stat('Conflicts', String(v.conflicts))}
             ${stat('Failed calls', String(v.failed), 'included in the denominator')}
             ${stat('Mean confidence', v.meanConfidence === null ? '—' : v.meanConfidence.toFixed(2))}
           </div>`;

  const disagreements = v.disagreements.length
    ? `<h3>Where they disagreed</h3>
       <table>
         <thead><tr><th>Time</th><th>Detector</th><th>Model</th><th>Conf.</th><th>What the model said it saw</th></tr></thead>
         <tbody>${v.disagreements
           .map(
             (d) =>
               `<tr><td class="mono">${clock(d.t)}</td><td>${esc(d.cv)}</td><td>${esc(d.ai)}</td>` +
               `<td class="mono">${d.confidence === null ? '—' : d.confidence.toFixed(2)}</td>` +
               `<td class="reason">${esc(d.reasoning)}</td></tr>`,
           )
           .join('')}</tbody>
       </table>`
    : '';

  // ── Conditions ──────────────────────────────────────────────────────
  const timeInRows = Object.entries(r.conditions.timeIn)
    .sort((a, b) => b[1].ms - a[1].ms)
    .map(
      ([cond, acc]) =>
        `<tr><td><span class="swatch" style="background:${COLOUR[cond as Condition] ?? '#888'}"></span>${esc(cond)}</td>` +
        `<td class="mono">${duration(acc.ms)}</td><td class="mono">${acc.pct}%</td>` +
        `<td class="mono">${acc.samples}</td></tr>`,
    )
    .join('');

  const dryingRows = r.crossovers.dryingWindows.length
    ? r.crossovers.dryingWindows
        .map(
          (w) =>
            `<tr><td class="mono">${clock(w.from)}</td><td class="mono">${duration(w.durationMs)}</td>` +
            `<td class="mono">${w.peakDivergence}</td></tr>`,
        )
        .join('')
    : '';

  // ── Incidents ───────────────────────────────────────────────────────
  const incidentRows = r.monitoring.incidents.length
    ? r.monitoring.incidents
        .map(
          (i) =>
            `<tr class="sev-${esc(i.severity)}"><td class="mono">${clock(i.openedAt)}</td>` +
            `<td><code>${esc(i.kind)}</code></td>` +
            `<td>${esc(i.summary)}<div class="muted small">${esc(i.detail)}</div></td>` +
            `<td class="mono">${i.closedAt ? duration(i.durationMs) : 'still open'}</td></tr>`,
        )
        .join('')
    : '';

  const latencyMissed = r.latency.samples > 0 && r.latency.overBudgetPct > 5;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PitVision — ${esc(where || r.session.id)}</title>
<style>
  :root {
    --bg:#f6f7f9; --panel:#fff; --ink:#14161a; --muted:#5d6470; --line:#e3e6ea;
    --warn:#b45309; --crit:#b91c1c; --ok:#15803d;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0e1014; --panel:#171a20; --ink:#e8eaee; --muted:#98a0ad; --line:#262b34;
      --warn:#fbbf24; --crit:#f87171; --ok:#4ade80;
    }
  }
  * { box-sizing:border-box }
  body {
    margin:0; padding:2rem 1.25rem 4rem; background:var(--bg); color:var(--ink);
    font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  }
  main { max-width:920px; margin:0 auto }
  header { margin-bottom:1.75rem }
  h1 { font-size:1.5rem; margin:0 0 .35rem }
  h2 { font-size:1.05rem; margin:2.25rem 0 .75rem; padding-bottom:.4rem; border-bottom:1px solid var(--line) }
  h3 { font-size:.95rem; margin:1.5rem 0 .5rem }
  .sub { color:var(--muted); font-size:.9rem }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-variant-numeric:tabular-nums }
  .muted { color:var(--muted) }
  .small { font-size:.82rem }
  section { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:1rem 1.25rem; margin-bottom:1rem }
  .headline li { margin:.3rem 0 }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:.75rem }
  .stat { border:1px solid var(--line); border-radius:8px; padding:.6rem .75rem }
  .stat .k { color:var(--muted); font-size:.78rem; text-transform:uppercase; letter-spacing:.04em }
  .stat .v { font-size:1.3rem; font-variant-numeric:tabular-nums; margin-top:.15rem }
  .stat .n { color:var(--muted); font-size:.78rem; margin-top:.1rem }
  .timeline { display:flex; height:34px; border-radius:6px; overflow:hidden; border:1px solid var(--line) }
  .timeline i { display:block }
  table { width:100%; border-collapse:collapse; margin-top:.5rem; font-size:.9rem }
  th { text-align:left; color:var(--muted); font-weight:600; font-size:.78rem; text-transform:uppercase; letter-spacing:.04em }
  th,td { padding:.45rem .5rem; border-bottom:1px solid var(--line); vertical-align:top }
  .swatch { display:inline-block; width:.7rem; height:.7rem; border-radius:2px; margin-right:.45rem }
  .reason { color:var(--muted); max-width:26rem }
  .sev-critical td:first-child { box-shadow:inset 3px 0 0 var(--crit) }
  .sev-warn td:first-child { box-shadow:inset 3px 0 0 var(--warn) }
  .warn-note { color:var(--warn); margin:.25rem 0 }
  .over { color:var(--crit) }
  .under { color:var(--ok) }
  .wrap { overflow-x:auto }
  footer { color:var(--muted); font-size:.8rem; margin-top:2rem }
  @media print { body { background:#fff } section { break-inside:avoid } }
</style>
</head><body><main>

<header>
  <h1>${esc(where || 'Session report')}</h1>
  <div class="sub">
    ${who ? esc(who) + ' · ' : ''}${esc(r.session.source.label ?? r.session.source.kind)} ·
    ${clock(r.coverage.firstReadingAt)}–${clock(r.coverage.lastReadingAt)} ·
    ${duration(r.coverage.spanMs)} of footage ·
    <span class="mono">${esc(r.session.id)}</span>
  </div>
</header>

<section>
  <ul class="headline">${r.headline.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
</section>

<h2>Track</h2>
<section>
  ${timelineBar(r.conditions.timeline, r.coverage.spanMs)}
  <div class="wrap"><table>
    <thead><tr><th>Condition</th><th>Time</th><th>Share</th><th>Samples</th></tr></thead>
    <tbody>${timeInRows || '<tr><td colspan="4" class="muted">No readings.</td></tr>'}</tbody>
  </table></div>

  <div class="stats" style="margin-top:1rem">
    ${stat('Peak wetness', String(r.wetness.max), r.wetness.peakAt ? `at ${clock(r.wetness.peakAt)}` : '')}
    ${stat('Mean', String(r.wetness.mean))}
    ${stat('Fastest rise', `${r.wetness.fastestRisePerMin}/min`)}
    ${stat('Fastest fall', `${r.wetness.fastestFallPerMin}/min`)}
    ${stat('Condition changes', String(r.conditions.changes))}
  </div>
</section>

${
  dryingRows
    ? `<h2>Dry line</h2>
       <section>
         <div class="wrap"><table>
           <thead><tr><th>Formed at</th><th>Held</th><th>Peak divergence</th></tr></thead>
           <tbody>${dryingRows}</tbody>
         </table></div>
         <p class="muted small">Divergence is edge minus racing line, in index points. It peaked at
         ${r.crossovers.maxDivergence}${r.crossovers.maxDivergenceAt ? ` at ${clock(r.crossovers.maxDivergenceAt)}` : ''}.</p>
       </section>`
    : ''
}

<h2>Was the detector trustworthy?</h2>
<section>
  ${verificationBlock}
  ${disagreements}
  ${
    v.cost.usd > 0
      ? `<p class="muted small">Verification used ${v.cost.inputTokens.toLocaleString()} input and
         ${v.cost.outputTokens.toLocaleString()} output tokens, costing $${v.cost.usd.toFixed(4)}
         across ${v.attempts} calls.</p>`
      : ''
  }
</section>

<h2>Pipeline health</h2>
<section>
  <div class="stats">
    ${stat('Readings', String(r.coverage.readings), `${Math.round(r.coverage.ratio * 100)}% coverage at 1 Hz`)}
    ${stat('Session open', duration(r.session.durationMs), 'wall clock')}
    ${stat('Largest gap', duration(r.coverage.largestGapMs))}
    ${stat('Latency p95', r.latency.samples ? `${r.latency.p95} ms` : '—', `budget ${r.latency.budgetMs} ms`)}
    ${stat('Over budget', r.latency.samples ? `${r.latency.overBudgetPct}%` : '—')}
    ${stat('Clean time', `${Math.round(r.monitoring.cleanRatio * 100)}%`, 'no incident open')}
  </div>
  ${
    latencyMissed
      ? `<p class="warn-note">The latency budget was missed: ${r.latency.overBudgetPct}% of frames took
         longer than ${r.latency.budgetMs} ms end to end. The condition on screen was lagging the track.</p>`
      : ''
  }
  ${
    incidentRows
      ? `<div class="wrap"><table>
           <thead><tr><th>Opened</th><th>Kind</th><th>What</th><th>Held</th></tr></thead>
           <tbody>${incidentRows}</tbody>
         </table></div>`
      : '<p class="muted">No incidents — the pipeline ran clean throughout.</p>'
  }
</section>

<h2>Calibration</h2>
<section>
  ${
    r.calibration.latest
      ? `<div class="stats">
           ${stat('Pre-race checks', String(r.calibration.runs))}
           ${stat('Last outcome', r.calibration.latest.ok ? 'passed' : 'failed', clock(r.calibration.latest.at))}
           ${stat('Anchoring', r.calibration.latest.anchoring ?? '—')}
           ${stat('Dry-line detection', r.calibration.latest.divergenceReliable === false ? 'disabled' : 'available',
             r.calibration.latest.divergenceReliable === false ? 'camera angle cannot see the edges' : '')}
         </div>`
      : `<p class="warn-note">No pre-race check was recorded. The wetness index for this session was
         scored against whatever anchors happened to be loaded, which may not have been measured
         on this footage.</p>`
  }
</section>

<footer>
  Generated by PitVision from the recorded session. Every figure is computed from the stored
  readings — nothing here is a model's summary of them.
</footer>

</main></body></html>`;
}
