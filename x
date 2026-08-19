<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PitVision — Montreal — FP2</title>
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
  <h1>Montreal — FP2</h1>
  <div class="sub">
    A. Rossi · #27 · Scuderia Demo · DM-24 · montreal-fp2-rain.mp4 ·
    18:56:38–19:18:37 ·
    21m 59s of footage ·
    <span class="mono">ses_4a5830bf433d4b88973a2c</span>
  </div>
</header>

<section>
  <ul class="headline"><li>22.0 min of footage analysed, 1320 readings, Dry for 36.4% of it.</li><li>Wetness index ranged 5–73.9 (mean 37.9), across 5 condition changes.</li><li>A dry line was called 1 time(s); the longest held 239s at up to 37.2 points of divergence.</li><li>Latency missed budget: p95 156ms against 100ms, 13.6% of frames over.</li><li>No AI verification ran — the detector was unchecked for this session.</li><li>1 incident(s) raised (1 critical); 64% of the session was clean.</li></ul>
</section>

<h2>Track</h2>
<section>
  <div class="timeline"><i style="flex:22.66868840030326;background:#ffb020" title="Dry · 4m 59s · 18:56:38–19:01:37 · peak 8"></i><i style="flex:9.021986353297953;background:#c9d152" title="Greasy · 1m 59s · 19:01:38–19:03:37 · peak 33.4"></i><i style="flex:13.570887035633056;background:#38bdf8" title="Damp · 2m 59s · 19:03:38–19:06:37 · peak 63.1"></i><i style="flex:22.66868840030326;background:#4f7cff" title="Wet · 4m 59s · 19:06:38–19:11:37 · peak 73.9"></i><i style="flex:18.11978771796816;background:#46e08a" title="Drying · 3m 59s · 19:11:38–19:15:37 · peak 58"></i><i style="flex:13.570887035633056;background:#ffb020" title="Dry · 2m 59s · 19:15:38–19:18:37 · peak 14"></i></div>
  <div class="wrap"><table>
    <thead><tr><th>Condition</th><th>Time</th><th>Share</th><th>Samples</th></tr></thead>
    <tbody><tr><td><span class="swatch" style="background:#ffb020"></span>Dry</td><td class="mono">7m 58s</td><td class="mono">36.4%</td><td class="mono">480</td></tr><tr><td><span class="swatch" style="background:#4f7cff"></span>Wet</td><td class="mono">4m 59s</td><td class="mono">22.8%</td><td class="mono">300</td></tr><tr><td><span class="swatch" style="background:#46e08a"></span>Drying</td><td class="mono">3m 59s</td><td class="mono">18.2%</td><td class="mono">240</td></tr><tr><td><span class="swatch" style="background:#38bdf8"></span>Damp</td><td class="mono">2m 59s</td><td class="mono">13.6%</td><td class="mono">180</td></tr><tr><td><span class="swatch" style="background:#c9d152"></span>Greasy</td><td class="mono">1m 59s</td><td class="mono">9.1%</td><td class="mono">120</td></tr></tbody>
  </table></div>

  <div class="stats" style="margin-top:1rem">
    <div class="stat"><div class="k">Peak wetness</div><div class="v">73.9</div><div class="n">at 19:11:03</div></div>
    <div class="stat"><div class="k">Mean</div><div class="v">37.9</div></div>
    <div class="stat"><div class="k">Fastest rise</div><div class="v">16/min</div></div>
    <div class="stat"><div class="k">Fastest fall</div><div class="v">-7/min</div></div>
    <div class="stat"><div class="k">Condition changes</div><div class="v">5</div></div>
  </div>
</section>

<h2>Dry line</h2>
       <section>
         <div class="wrap"><table>
           <thead><tr><th>Formed at</th><th>Held</th><th>Peak divergence</th></tr></thead>
           <tbody><tr><td class="mono">19:11:38</td><td class="mono">3m 59s</td><td class="mono">37.2</td></tr></tbody>
         </table></div>
         <p class="muted small">Divergence is edge minus racing line, in index points. It peaked at
         37.2 at 19:15:37.</p>
       </section>

<h2>Was the detector trustworthy?</h2>
<section>
  <p class="warn-note">No AI verification ran during this session. The detector was
         unchecked — that is not the same as it having been correct.</p>
  
  
</section>

<h2>Pipeline health</h2>
<section>
  <div class="stats">
    <div class="stat"><div class="k">Readings</div><div class="v">1320</div><div class="n">100% coverage at 1 Hz</div></div>
    <div class="stat"><div class="k">Session open</div><div class="v">3s</div><div class="n">wall clock</div></div>
    <div class="stat"><div class="k">Largest gap</div><div class="v">1s</div></div>
    <div class="stat"><div class="k">Latency p95</div><div class="v">156 ms</div><div class="n">budget 100 ms</div></div>
    <div class="stat"><div class="k">Over budget</div><div class="v">13.6%</div></div>
    <div class="stat"><div class="k">Clean time</div><div class="v">64%</div><div class="n">no incident open</div></div>
  </div>
  <p class="warn-note">The latency budget was missed: 13.6% of frames took
         longer than 100 ms end to end. The condition on screen was lagging the track.</p>
  <div class="wrap"><table>
           <thead><tr><th>Opened</th><th>Kind</th><th>What</th><th>Held</th></tr></thead>
           <tbody><tr class="sev-critical"><td class="mono">19:18:40</td><td><code>feed_stall</code></td><td>Feed stalled<div class="muted small">No readings for 1.3s (limit 1.2s). The readout on screen is frozen at its last value, which is indistinguishable from stable weather.</div></td><td class="mono">1s</td></tr></tbody>
         </table></div>
</section>

<h2>Calibration</h2>
<section>
  <div class="stats">
           <div class="stat"><div class="k">Pre-race checks</div><div class="v">1</div></div>
           <div class="stat"><div class="k">Last outcome</div><div class="v">passed</div><div class="n">19:18:38</div></div>
           <div class="stat"><div class="k">Anchoring</div><div class="v">measured-both-ends</div></div>
           <div class="stat"><div class="k">Dry-line detection</div><div class="v">available</div></div>
         </div>
</section>

<footer>
  Generated by PitVision from the recorded session. Every figure is computed from the stored
  readings — nothing here is a model's summary of them.
</footer>

</main></body></html>