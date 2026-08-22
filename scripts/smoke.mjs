/**
 * End-to-end smoke test for the backend.
 *
 * Boots a real server against a throwaway database and drives a whole session
 * through it: start, stream a synthetic weather cycle in, trip each monitor
 * check on purpose, and read the report back. It asserts on behaviour rather
 * than on status codes — that an incident opened when the feed stalled and
 * closed when it resumed is the thing worth knowing.
 *
 *   npm run smoke
 *
 * Verification is not exercised here: it costs money and needs a key. The
 * `--verify` flag turns it on if ANTHROPIC_API_KEY is set.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.SMOKE_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}/api`;
const dir = mkdtempSync(join(tmpdir(), 'pitvision-smoke-'));

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function api(method, path, body, opts = {}) {
  const res = await fetch(`${opts.base ?? BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body is itself a finding */
  }
  if (!opts.allowError && !res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return { status: res.status, body: json, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Boot ─────────────────────────────────────────────────────────────

const children = [];

/**
 * Start a server. Thresholds are tightened so the watchdogs can be tripped
 * inside a short run rather than by waiting out production timings.
 */
function startServer(port, dbName, extraEnv = {}) {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', '--import', './scripts/ts-resolve.mjs', 'server/index.ts'],
    {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        PITVISION_DB: join(dir, dbName),
        LOG_LEVEL: process.env.SMOKE_VERBOSE ? 'debug' : 'error',
        PITVISION_MONITOR_TICK_MS: '400',
        PITVISION_STALL_MS: '1500',
        PITVISION_INSTABILITY_FLIPS: '4',
        PITVISION_INSTABILITY_WINDOW_MS: '30000',
        PITVISION_LATENCY_BUDGET_MS: '100',
        PITVISION_SURGE_PER_MIN: '14',
        PITVISION_LANE_LOST_MS: '1500',
        NODE_ENV: 'test',
        ...extraEnv,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
  children.push(child);
  return child;
}

async function waitForServer(base, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`server at ${base} did not start`);
}

function cleanup() {
  for (const child of children) child.kill('SIGTERM');
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

startServer(PORT, 'smoke.db');

// ── Fixtures ─────────────────────────────────────────────────────────

/** One reading, with the shape the client posts. */
function reading(t, { wetness, condition, line, edge, trend = 0, latencyMs = 40 }) {
  return {
    t,
    wetness,
    wetnessRaw: wetness,
    line: line ?? wetness,
    edge: edge ?? wetness,
    divergence: (edge ?? wetness) - (line ?? wetness),
    condition,
    trend,
    signals: { glare: 0.02, texture: 900, darkness: 0.5, specular: 0.2 },
    normalised: { glare: 0.3, texture: 0.4, darkness: 0.5, specular: 0.3 },
    analysisMs: 6,
    latencyMs,
  };
}

/** A dry → wet → drying arc, one reading per second. */
function weatherArc(startT, seconds) {
  const rows = [];
  for (let i = 0; i < seconds; i++) {
    const t = startT + i * 1000;
    const phase = i / seconds;
    if (phase < 0.25) {
      rows.push(reading(t, { wetness: 6 + i * 0.2, condition: 'Dry', trend: 1 }));
    } else if (phase < 0.5) {
      rows.push(reading(t, { wetness: 40 + i, condition: 'Damp', trend: 20 }));
    } else if (phase < 0.75) {
      rows.push(reading(t, { wetness: 70, condition: 'Wet', trend: 2 }));
    } else {
      rows.push(
        reading(t, { wetness: 45, condition: 'Drying', line: 30, edge: 58, trend: -8 }),
      );
    }
  }
  return rows;
}

// ── The run ──────────────────────────────────────────────────────────

async function run() {
  await waitForServer(BASE);

  section('Health and readiness');
  {
    const health = await api('GET', '/health');
    check('GET /api/health is live', health.body?.ok === true && health.body.status === 'live');
    check('health still reports the legacy `configured` field', 'configured' in health.body);

    const ready = await api('GET', '/ready', null, { allowError: true });
    check('GET /api/ready checks the database', ready.body?.checks?.database?.ok === true);
    check('readiness proves the database is writable', ready.body?.checks?.writable?.ok === true);
    check(
      'a missing API key is degraded, not unready',
      ready.status === 200 && ready.body?.status === 'degraded',
      `got ${ready.status}/${ready.body?.status}`,
    );
  }

  section('Validation rejects bad input');
  {
    const noSource = await api('POST', '/sessions', {}, { allowError: true });
    check('a session with no source is a 400', noSource.status === 400);
    check('the error names the offending field', /source/.test(noSource.body?.error ?? ''));
    check('the error carries a request id', typeof noSource.body?.requestId === 'string');

    const badKind = await api(
      'POST',
      '/sessions',
      { source: { kind: 'telepathy' } },
      { allowError: true },
    );
    check('an unknown source kind is rejected', badKind.status === 400);
  }

  section('Session lifecycle');
  let sessionId;
  {
    const created = await api('POST', '/sessions', {
      source: { kind: 'video', label: 'montreal-rain.mp4', signature: 'sig-montreal' },
      entrant: { driver: 'Test Driver', number: '44', team: 'Smoke', circuit: 'Montreal', session: 'FP2' },
      baselineLapS: 92.5,
      appVersion: '3.1.0',
    });
    sessionId = created.body?.session?.id;
    check('POST /api/sessions returns 201 with an id', created.status === 201 && !!sessionId);
    check('the entrant is stored', created.body?.session?.entrant?.driver === 'Test Driver');

    const listed = await api('GET', '/sessions?status=active');
    check('the session appears in the active list', listed.body?.sessions?.some((s) => s.id === sessionId));
  }

  section('Telemetry ingest');
  const t0 = Date.now() - 120_000;
  {
    const arc = weatherArc(t0, 100);
    for (let i = 0; i < arc.length; i += 20) {
      const res = await api('POST', `/sessions/${sessionId}/readings`, {
        readings: arc.slice(i, i + 20),
        sourceSignature: 'sig-montreal',
      });
      if (i === 0) check('a reading batch is accepted with 202', res.status === 202);
    }

    const stored = await api('GET', `/sessions/${sessionId}/readings?limit=500`);
    check(`all ${arc.length} readings were stored`, stored.body?.count === arc.length, `got ${stored.body?.count}`);

    // At-least-once delivery: a client retrying a batch must not duplicate rows
    // or fail on the ones that already landed.
    await api('POST', `/sessions/${sessionId}/readings`, { readings: arc.slice(0, 20) });
    const again = await api('GET', `/sessions/${sessionId}/readings?limit=500`);
    check('a replayed batch does not duplicate rows', again.body?.count === arc.length, `got ${again.body?.count}`);

    const badCondition = await api(
      'POST',
      `/sessions/${sessionId}/readings`,
      { readings: [reading(Date.now(), { wetness: 10, condition: 'Moist' })] },
      { allowError: true },
    );
    check('an unknown condition label is rejected', badCondition.status === 400);
  }

  section('Events and calibration');
  {
    await api('POST', `/sessions/${sessionId}/events`, {
      events: [
        { kind: 'condition', level: 'warn', title: 'Damp', detail: 'Surface darkening' },
        { kind: 'crossover', level: 'critical', title: 'Dry line forming', detail: 'Δ 28' },
      ],
    });
    const events = await api('GET', `/sessions/${sessionId}/events`);
    check('client pings are stored', events.body?.events?.length >= 2);

    await api('POST', `/sessions/${sessionId}/calibration`, {
      ok: true,
      verdict: 'measured-both-ends',
      anchoring: 'wet-anchored',
      divergenceReliable: true,
      sourceSignature: 'sig-montreal',
      checks: [{ id: 'decode', state: 'pass' }],
      anchors: { dry: { texture: 1400 }, wet: { texture: 300 } },
    });
    const calib = await api('GET', `/sessions/${sessionId}/calibration`);
    check('the pre-race check is recorded with its anchors', calib.body?.calibrations?.length === 1);
  }

  section('Monitor: feed stall opens and closes an incident');
  {
    await sleep(2600); // past the 1500ms stall threshold, with sweeps at 400ms
    const open = await api('GET', `/sessions/${sessionId}/incidents?open=true`);
    check(
      'a stalled feed opens a critical incident',
      open.body?.incidents?.some((i) => i.kind === 'feed_stall' && i.severity === 'critical'),
      JSON.stringify(open.body?.incidents?.map((i) => i.kind)),
    );

    await api('POST', `/sessions/${sessionId}/readings`, {
      readings: [reading(Date.now(), { wetness: 30, condition: 'Damp' })],
    });
    await sleep(900);
    const after = await api('GET', `/sessions/${sessionId}/incidents?open=true`);
    check(
      'the incident closes itself when readings resume',
      !after.body?.incidents?.some((i) => i.kind === 'feed_stall'),
    );

    const all = await api('GET', `/sessions/${sessionId}/incidents`);
    check(
      'the closed incident is kept with its duration',
      all.body?.incidents?.some((i) => i.kind === 'feed_stall' && i.closed_at !== null),
    );
  }

  section('Monitor: a strobing classifier is caught');
  let strobeId;
  {
    const created = await api('POST', '/sessions', {
      source: { kind: 'video', label: 'strobe.mp4', signature: 'sig-strobe' },
    });
    strobeId = created.body.session.id;

    const now = Date.now();
    const flips = ['Dry', 'Damp', 'Dry', 'Damp', 'Wet', 'Damp', 'Dry', 'Damp'];
    await api('POST', `/sessions/${strobeId}/readings`, {
      readings: flips.map((c, i) => reading(now + i * 200, { wetness: 30, condition: c })),
      sourceSignature: 'sig-strobe',
    });

    await sleep(900);
    const open = await api('GET', `/sessions/${strobeId}/incidents?open=true`);
    check(
      'rapid condition flips open an instability incident',
      open.body?.incidents?.some((i) => i.kind === 'condition_instability'),
      JSON.stringify(open.body?.incidents?.map((i) => i.kind)),
    );
  }

  section('Monitor: latency budget and calibration mismatch');
  {
    const created = await api('POST', '/sessions', {
      source: { kind: 'screen', label: 'broadcast', signature: 'sig-live' },
    });
    const slowId = created.body.session.id;

    const now = Date.now();
    // 40 frames, every one of them well past the 100ms budget.
    await api('POST', `/sessions/${slowId}/readings`, {
      readings: Array.from({ length: 40 }, (_, i) =>
        reading(now + i * 100, { wetness: 20, condition: 'Greasy', latencyMs: 260 }),
      ),
      // A signature that does not match the one the session was calibrated on.
      sourceSignature: 'sig-different-clip',
    });

    await sleep(900);
    const open = await api('GET', `/sessions/${slowId}/incidents?open=true`);
    const kinds = open.body?.incidents?.map((i) => i.kind) ?? [];
    check('a breached latency budget is caught', kinds.includes('latency_budget'), JSON.stringify(kinds));
    check('anchors from another feed are caught', kinds.includes('calibration_mismatch'), JSON.stringify(kinds));

    const ops = await api('GET', '/incidents');
    check('open incidents are visible across all sessions', ops.body?.incidents?.length >= 2);
  }

  section('Live stream');
  {
    const controller = new AbortController();
    const res = await fetch(`${BASE}/sessions/${sessionId}/stream`, { signal: controller.signal });
    check('the stream responds as an event stream', res.headers.get('content-type')?.includes('text/event-stream'));

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value ?? new Uint8Array());

    // The snapshot may arrive in the same chunk as the retry directive or the
    // one after it, depending on how the socket flushes.
    const snapshot = first.includes('event: snapshot')
      ? first
      : decoder.decode((await reader.read()).value ?? new Uint8Array());
    check('a new subscriber gets a snapshot immediately', snapshot.includes('event: snapshot'));

    const pushed = (async () => {
      const chunks = [];
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        chunks.push(text);
        if (text.includes('event: reading')) return chunks.join('');
      }
      return chunks.join('');
    })();

    await sleep(200);
    await api('POST', `/sessions/${sessionId}/readings`, {
      readings: [reading(Date.now(), { wetness: 55, condition: 'Wet' })],
    });

    const streamed = await pushed;
    check('a new reading is pushed to subscribers', streamed.includes('event: reading'), streamed.slice(0, 120));
    controller.abort();
  }

  section('A lost lane trace is caught');
  {
    // The failure mode with no visible symptom: readings keep arriving,
    // correctly computed, over a region that is no longer the track.
    const created = await api('POST', '/sessions', {
      source: { kind: 'screen', label: 'lane-loss', signature: 'sig-lane' },
    });
    const laneId = created.body.session.id;

    const post = (state) =>
      api('POST', `/sessions/${laneId}/readings`, {
        readings: [reading(Date.now(), { wetness: 30, condition: 'Damp' })],
        sourceSignature: 'sig-lane',
        lane: { state, confidence: state === 'locked' ? 0.9 : 0 },
      });

    await post('locked');
    await sleep(600);
    let open = await api('GET', `/sessions/${laneId}/incidents?open=true`);
    check('a locked trace raises nothing', !open.body?.incidents?.some((i) => i.kind === 'lane_lost'));

    // Lose it and hold it lost past the threshold.
    for (let i = 0; i < 5; i++) {
      await post('lost');
      await sleep(500);
    }
    open = await api('GET', `/sessions/${laneId}/incidents?open=true`);
    check(
      'a sustained loss opens a critical incident',
      open.body?.incidents?.some((i) => i.kind === 'lane_lost' && i.severity === 'critical'),
      JSON.stringify(open.body?.incidents?.map((i) => i.kind)),
    );

    await post('locked');
    await sleep(700);
    open = await api('GET', `/sessions/${laneId}/incidents?open=true`);
    check('regaining the road closes it', !open.body?.incidents?.some((i) => i.kind === 'lane_lost'));

    // A hand-aimed region is not a lost trace and must not be reported as one.
    await api('POST', `/sessions/${laneId}/readings`, {
      readings: [reading(Date.now(), { wetness: 30, condition: 'Damp' })],
      lane: { state: 'manual', confidence: 0 },
    });
    await sleep(600);
    open = await api('GET', `/sessions/${laneId}/incidents?open=true`);
    check('a manual ROI is not reported as a lost trace', !open.body?.incidents?.some((i) => i.kind === 'lane_lost'));

    const bad = await api(
      'POST',
      `/sessions/${laneId}/readings`,
      {
        readings: [reading(Date.now(), { wetness: 30, condition: 'Damp' })],
        lane: { state: 'confused', confidence: 0 },
      },
      { allowError: true },
    );
    check('an unknown lane state is rejected', bad.status === 400);

    await api('POST', `/sessions/${laneId}/end`, { reason: 'lane test done' });
  }

  section('Incidents reach subscribers live');
  {
    // The reason the monitor exists is that somebody is told. This is the wire
    // between the two: the browser tab running the detector subscribes to its
    // own session and turns these frames into pit-wall pings.
    const created = await api('POST', '/sessions', {
      source: { kind: 'video', label: 'incident-stream.mp4', signature: 'sig-inc' },
    });
    const incId = created.body.session.id;

    await api('POST', `/sessions/${incId}/readings`, {
      readings: [reading(Date.now(), { wetness: 20, condition: 'Greasy' })],
      sourceSignature: 'sig-inc',
    });

    const controller = new AbortController();
    const res = await fetch(`${BASE}/sessions/${incId}/stream`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    /** Read frames until `event: <name>` shows up, or time out. */
    async function until(eventName, ms) {
      const deadline = Date.now() + ms;
      let buffer = '';
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes(`event: ${eventName}`)) return buffer;
      }
      return null;
    }

    // Stop posting readings: the stall watchdog fires at 1500ms in this config.
    const opened = await until('incident.opened', 8000);
    check('an opened incident is pushed to subscribers', opened !== null);
    check(
      'the frame carries the kind and severity a client needs to render it',
      opened !== null && /"kind":"feed_stall"/.test(opened) && /"severity":"critical"/.test(opened),
      opened?.slice(-160),
    );
    check(
      'it carries the detail explaining what is wrong',
      opened !== null && /"detail":"[^"]+/.test(opened),
    );

    // Resume the feed; the incident must close itself and say so on the wire,
    // or a client would leave the warning on screen forever.
    await api('POST', `/sessions/${incId}/readings`, {
      readings: [reading(Date.now(), { wetness: 20, condition: 'Greasy' })],
    });
    const closed = await until('incident.closed', 8000);
    check('the matching close is pushed too', closed !== null);
    check(
      'the closed frame carries closed_at, so a client can show how long it held',
      closed !== null && /"closed_at":\d+/.test(closed),
      closed?.slice(-160),
    );

    controller.abort();
    await api('POST', `/sessions/${incId}/end`, { reason: 'incident stream test done' });
  }

  section('Rate limiting protects the paid endpoint');
  {
    // Verification is limited per client; fire past the bucket and confirm the
    // limiter answers before the request reaches the model.
    const results = [];
    for (let i = 0; i < 45; i++) {
      results.push(
        await api(
          'POST',
          '/verify',
          { image: 'data:image/jpeg;base64,AAAA', sessionId },
          { allowError: true },
        ),
      );
    }
    const limited = results.filter((r) => r.status === 429);
    check('the verify bucket eventually rate limits', limited.length > 0, `${limited.length} of 45 limited`);
    check('a limited response carries retry-after guidance', limited[0]?.body?.details?.retryAfterSec > 0);
  }

  section('Session report');
  {
    const ended = await api('POST', `/sessions/${sessionId}/end`, { reason: 'smoke test complete' });
    check('ending a session returns its report', !!ended.body?.report);

    const r = ended.body.report;
    check('the report counts the readings', r.coverage.readings > 100, String(r.coverage.readings));
    check('the condition timeline has segments', r.conditions.timeline.length >= 4, String(r.conditions.timeline.length));
    check('time-in-condition adds up to ~100%', Math.abs(Object.values(r.conditions.timeIn).reduce((a, b) => a + b.pct, 0) - 100) < 1.5);
    check('the drying window was detected', r.crossovers.dryingWindows.length >= 1);
    check('peak divergence is reported', r.crossovers.maxDivergence >= 28, String(r.crossovers.maxDivergence));
    check('latency stats are computed', r.latency.samples > 0 && r.latency.p95 > 0);
    check('the incident history is in the report', r.monitoring.incidents.length >= 1);
    check('a clean-time ratio is computed', r.monitoring.cleanRatio >= 0 && r.monitoring.cleanRatio <= 1);
    check(
      'an unconfigured key is not recorded as a failed verification',
      r.verification.attempts === 0,
      `got ${r.verification.attempts} attempts`,
    );
    check('the headline is generated from the numbers', Array.isArray(r.headline) && r.headline.length >= 3);
    check('the calibration run is in the report', r.calibration.runs === 1);

    const again = await api('POST', `/sessions/${sessionId}/end`, {}, { allowError: true });
    check('ending an already-ended session is a 409', again.status === 409);

    const rejected = await api(
      'POST',
      `/sessions/${sessionId}/readings`,
      { readings: [reading(Date.now(), { wetness: 1, condition: 'Dry' })] },
      { allowError: true },
    );
    check('an ended session accepts no more readings', rejected.status === 409);

    if (process.env.SMOKE_PRINT_REPORT) {
      console.log('\n' + r.headline.map((l) => `    • ${l}`).join('\n'));
    }
  }

  section('Verification failures are recorded, not swallowed');
  {
    // A second server, configured with a key pointed at a port nothing is
    // listening on. Every call fails at the transport, which is the case the
    // original proxy handled by logging a line and returning a 502 — leaving no
    // way afterwards to tell a session where verification never worked from one
    // where it agreed every time.
    const failPort = PORT + 1;
    const failBase = `http://127.0.0.1:${failPort}/api`;
    startServer(failPort, 'fail.db', {
      ANTHROPIC_API_KEY: 'smoke-not-a-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      PITVISION_VERIFY_TIMEOUT_MS: '1500',
      PITVISION_VERIFY_RETRIES: '0',
      PITVISION_VERIFY_FAIL_STREAK: '3',
    });
    await waitForServer(failBase);

    const ready = await api('GET', '/ready', null, { base: failBase, allowError: true });
    check('a configured key reports ready', ready.body?.status === 'ready', ready.body?.status);

    const created = await api('POST', '/sessions', {
      source: { kind: 'video', label: 'verify-fail.mp4', signature: 'sig-vf' },
    }, { base: failBase });
    const vfId = created.body.session.id;

    await api('POST', `/sessions/${vfId}/readings`, {
      readings: [reading(Date.now(), { wetness: 70, condition: 'Wet' })],
      sourceSignature: 'sig-vf',
    }, { base: failBase });

    const image = 'data:image/jpeg;base64,' + Buffer.from('not-a-real-jpeg').toString('base64');
    const attempts = [];
    for (let i = 0; i < 4; i++) {
      attempts.push(
        await api('POST', '/verify', {
          image,
          sessionId: vfId,
          cv: { condition: 'Wet', wetness: 70, racingLine: 68, trackEdges: 72, divergence: 4, trendPerMin: 1 },
        }, { base: failBase, allowError: true }),
      );
    }
    check('an unreachable model surfaces as an error status', attempts.every((a) => a.status >= 400));

    const recorded = await api('GET', `/sessions/${vfId}/verifications`, null, { base: failBase });
    check('every failed attempt is written to the audit log', recorded.body?.verifications?.length === 4, `got ${recorded.body?.verifications?.length}`);
    check('the failure carries the CV call it was checking', recorded.body?.verifications?.[0]?.cv_condition === 'Wet');
    check('the failure carries the underlying error', typeof recorded.body?.verifications?.[0]?.error === 'string');

    await sleep(900);
    const open = await api('GET', `/sessions/${vfId}/incidents?open=true`, null, { base: failBase });
    check(
      'a run of failures opens a verification_down incident',
      open.body?.incidents?.some((i) => i.kind === 'verification_down'),
      JSON.stringify(open.body?.incidents?.map((i) => i.kind)),
    );

    const ended = await api('POST', `/sessions/${vfId}/end`, { reason: 'done' }, { base: failBase });
    const vr = ended.body.report.verification;
    check('the report counts the failures', vr.attempts === 4 && vr.failed === 4, JSON.stringify(vr));
    check('agreement is null rather than 100% when nothing succeeded', vr.agreementRate === null);
    check(
      'the headline says the detector went unverified',
      ended.body.report.headline.some((l) => /unchecked|no comparable/i.test(l)),
      JSON.stringify(ended.body.report.headline),
    );
  }

  section('Auth, when a token is configured');
  {
    // The probes must stay reachable without the token. A liveness check that
    // 401s is read by a load balancer as a dead container, and restarting will
    // not produce a token.
    const authPort = PORT + 2;
    const authBase = `http://127.0.0.1:${authPort}/api`;
    startServer(authPort, 'auth.db', { PITVISION_API_TOKEN: 'smoke-token' });
    await waitForServer(authBase);

    const health = await api('GET', '/health', null, { base: authBase, allowError: true });
    check('liveness stays public', health.status === 200, String(health.status));

    const ready = await api('GET', '/ready', null, { base: authBase, allowError: true });
    check('readiness stays public', ready.status === 200, String(ready.status));

    const noToken = await api('POST', '/sessions', { source: { kind: 'synthetic' } }, { base: authBase, allowError: true });
    check('writes without a token are rejected', noToken.status === 401);

    const reads = await api('GET', '/sessions', null, { base: authBase, allowError: true });
    check('reads without a token are rejected', reads.status === 401);

    const metrics = await api('GET', '/metrics', null, { base: authBase, allowError: true });
    check('metrics are not left open', metrics.status === 401);

    const good = await fetch(`${authBase}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer smoke-token' },
      body: JSON.stringify({ source: { kind: 'synthetic' } }),
    });
    check('a valid bearer token is accepted', good.status === 201, String(good.status));

    const wrong = await fetch(`${authBase}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify({ source: { kind: 'synthetic' } }),
    });
    check('a wrong token is rejected', wrong.status === 401, String(wrong.status));
  }

  section('The segmenter proxy degrades instead of erroring');
  {
    // This server has no PITVISION_SEGMENTER_URL, which is the configuration
    // most deployments run. The browser polls this endpoint several times a
    // second regardless, so "not configured" has to be an ordinary answer
    // rather than an error — otherwise every install without a model gets a
    // console full of failures for a setup that is working as intended.
    const health = await api('GET', '/segment/health');
    check('health reports the segmenter as unconfigured', health.body?.configured === false);
    check('and says why', typeof health.body?.reason === 'string' && health.body.reason.length > 0);

    const codes = [];
    for (let i = 0; i < 6; i++) {
      const res = await api('POST', '/segment', { image: 'data:image/jpeg;base64,AAAA' }, { allowError: true });
      codes.push(res.status);
    }
    check('every call is a 200, never a 5xx', codes.every((c) => c === 200), codes.join(','));

    const one = await api('POST', '/segment', { image: 'data:image/jpeg;base64,AAAA' });
    check('the corridor is explicitly null', one.body?.corridor === null);
    check('with a reason the client can show', typeof one.body?.reason === 'string');

    const bad = await api('POST', '/segment', {}, { allowError: true });
    check('a request with no image is still a 400', bad.status === 400, String(bad.status));
  }

  section('Metrics');
  {
    const metrics = await api('GET', '/metrics');
    check('metrics are exposed in Prometheus format', metrics.text.includes('pitvision_http_requests_total'));
    check('readings ingested are counted', metrics.text.includes('pitvision_readings_ingested_total'));
    check('incidents opened are counted by kind', /pitvision_incidents_opened_total\{kind=/.test(metrics.text));

    const stats = await api('GET', '/stats');
    check('the stats view lists active sessions', Array.isArray(stats.body?.sessions?.list));
    check('the stats view reports open incidents', typeof stats.body?.incidents?.open === 'number');
  }

  section('404s');
  {
    const missing = await api('GET', '/sessions/ses_nonexistent', null, { allowError: true });
    check('an unknown session is a 404 with a message', missing.status === 404 && /ses_nonexistent/.test(missing.body?.error));

    const noRoute = await api('GET', '/nope', null, { allowError: true });
    check('an unknown API route is a JSON 404', noRoute.status === 404 && noRoute.body?.code === 'not_found');
  }
}

try {
  await run();
} catch (err) {
  failed++;
  console.error(`\n\x1b[31mSmoke run threw:\x1b[0m ${err.message}`);
} finally {
  cleanup();
}

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
