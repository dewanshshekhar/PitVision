# The backend

The detector runs in the browser. This records what it produced, watches it while
it runs, and turns the result into something readable afterwards.

It replaces `server/proxy.mjs`, which was 151 lines that forwarded a JPEG to the
Anthropic API and served static files. Everything else the session produced —
every reading, every ping, every verification, the calibration it was all scored
against — lived in that one tab and died with it.

```
node server/index.ts          # no build step: Node strips the types
```

Zero new runtime dependencies. Storage is `node:sqlite`, which ships with Node 22:
a pit wall is a laptop in a garage with unreliable networking, and a single file
that survives a power cut is worth more here than anything needing a connection
string.

---

## What it does

**Records.** Sessions, readings, pings, verifications, calibration reports and
monitor findings, in one ordered stream per session.

**Monitors.** Seven watchdogs run server-side against every active session and
raise incidents with an open/closed lifecycle — so "is anything wrong right now"
is one query, not a scan back through a log guessing which warnings still stand.

**Reports.** A session report computed from the stored series: the condition
timeline, time in each condition, when the dry line formed, whether the latency
budget held, how often the AI agreed with the detector, and what it cost.

**Fans out.** Any number of read-only clients can subscribe to a session over
SSE. The engineer who needs to see "dry line forming" is not necessarily the one
holding the laptop the footage is loaded on.

---

## The monitor

The browser tells a strategist what the weather is doing. Nothing told anyone
whether the thing producing that answer was still working. Each check answers a
question that has a wrong answer the UI would show confidently:

| Incident | Fires when | Why it matters |
|---|---|---|
| `feed_stall` | No readings for `PITVISION_STALL_MS` | A frozen readout looks exactly like stable weather |
| `latency_budget` | p95 end-to-end over budget for >5% of recent frames | The condition on screen is lagging the track |
| `verification_drift` | Weighted agreement under 50% over the last 12 comparable checks | The index is being scored against the wrong anchors |
| `verification_down` | 3 consecutive verification failures | The "verified" chip is stale, not reassuring |
| `condition_instability` | 6+ condition changes in 30s | Hysteresis is not holding — contradictory tyre calls |
| `calibration_mismatch` | Feed signature ≠ calibration signature | Readings are not comparable with this footage |
| `rapid_wetting` | Sustained trend over 14 index points/min | Weather, not infrastructure — compound change territory |
| `lane_lost` | The tracer has been lost for over 5s | Readings still arrive, measured through a region that may no longer be track |

Every one closes itself when the condition clears. A monitor that only ever
raises alarms gets muted within a day, and then it is not a monitor.

Thresholds are all environment variables — see `.env.example`.

---

## Two bugs this surfaced

**The verification enum was a subset of the classifier's.** The proxy offered the
model `Dry | Damp | Wet | Drying | Unknown`. The engine classifies into seven
states. Every frame the engine called `Sunny`, `Greasy` or `Flooded` was recorded
as a disagreement *by construction* — the model had no way to spell the word it
was being compared against, so the card read "flags for review" on frames where
both sides had seen the same thing. The enum is now the full set.

**Agreement was a boolean.** `Damp` against `Wet` is two people looking at the
same tarmac splitting a judgement call. `Dry` against `Flooded` is a broken
detector. Scoring them identically buried the one that mattered, so the grade is
now `match` / `adjacent` / `conflict` / `unknown`, and the agreement rate counts
a neighbouring band as half credit.

---

## API

Everything is under `/api`. Errors share one shape — `{error, code, requestId}` —
and the request id is on the response header too, so a report of "it broke" can
be matched to a log line without guessing.

### Health

| | |
|---|---|
| `GET /health` | Liveness. Never fails for a missing API key — restarting will not produce one |
| `GET /ready` | Readiness. Proves the database is reachable *and writable*, rather than reporting `configured: true` for a revoked key |

### Sessions

| | |
|---|---|
| `POST /sessions` | Open a session for a feed |
| `GET /sessions` | List, with `?status=active\|ended\|abandoned` |
| `GET /sessions/:id` | Session, latest reading, open incidents |
| `PATCH /sessions/:id` | Update entrant, source label, baseline lap, notes |
| `POST /sessions/:id/end` | Close it; responds with the full report |

### Ingest

| | |
|---|---|
| `POST /sessions/:id/readings` | Batched readings. Idempotent on `(session, t)`, so a retried batch is harmless |
| `POST /sessions/:id/events` | Pit-wall pings |
| `POST /sessions/:id/calibration` | A pre-race check outcome plus the anchors it produced |

### Reads

`GET /sessions/:id/{readings,events,verifications,incidents,calibration,report}`

### Live

| | |
|---|---|
| `GET /sessions/:id/stream` | SSE for one session — a second screen on the pit wall |
| `GET /stream` | SSE for everything — the operations view |

Both open with a `snapshot` event, so a client that connects mid-session is
immediately correct rather than blank until the next event fires.

### Verification

`POST /verify` — request and response shapes are unchanged from the original
proxy, so an older client keeps working. Added around them: a per-client rate
limit (this is the endpoint that spends money), a timeout, transport-fault
retries, and a row in `verifications` for *every* attempt including the failures.
The failures are the point — an agreement rate computed only over the calls that
succeeded is a survivorship-biased number.

### Operations

| | |
|---|---|
| `GET /metrics` | Prometheus exposition format |
| `GET /stats` | The same picture shaped for a dashboard |
| `GET /incidents` | Everything currently wrong, across every session |

---

## Ingest rate

The engine commits a reading on every analysed frame — up to 25 a second. The
client downsamples to 1 Hz and batches before posting: the weather does not move
at 25 Hz, and an HTTP round trip does not belong anywhere near a path whose
design goal is a 100 ms budget.

The client is fire-and-forget throughout and swallows its own failures. Readings
queue while the backend is unreachable and go out in the next flush. If the
backend is down the detector does not notice.

---

## Layout

```
server/
  index.ts         bootstrap, graceful shutdown, housekeeping
  app.ts           express wiring: request ids, auth, limits, error shape
  config.ts        env parsed and validated once, at boot
  context.ts       what a route handler is allowed to reach
  db/              connection, pragmas, schema
  domain/          the condition vocabulary and agreement grading
  lib/             logging, typed errors, validation, rate limiting
  routes/          health, sessions, verify, stream, ops
  services/        store, monitor, verification, report, bus, metrics
src/telemetry/     the browser-side client
scripts/smoke.mjs  end-to-end test — boots a server, drives a session through it
```

---

## Testing

```bash
npm run smoke        # 77 checks against a real server on a throwaway database
npm run typecheck    # frontend and server
```

`lane_lost` is the one with no visible symptom. Every other failure either stops the
numbers or makes them visibly wrong; this one keeps them flowing, correctly computed,
over a corridor left over from before the camera cut away. The index stays in range,
the trend stays smooth, and it is describing a pit wall.

The smoke test trips each watchdog on purpose — stalls a feed, strobes the
classifier, breaches the latency budget, points verification at a dead port —
and asserts the incident opened *and* closed again. It asserts on behaviour, not
status codes.

Verification against the real API is not exercised: it costs money and needs a
key.
