# PitVision

**Live track condition detector.** A trackside camera feed is analysed continuously by a
computer-vision pipeline running in the browser, which calls the surface condition —
**Dry / Damp / Wet / Drying** — and turns it into a tyre call. A vision model checks the
read every few seconds and explains itself in plain language.

> The detection is ours. The AI verifies and explains — it does not do the seeing.

---

## Run it

```bash
npm install
npm run dev
```

Open <http://localhost:5173> and **drop your track footage onto the video panel**. That is
the whole setup:

1. The clip loads and the **pre-race check** runs automatically — playback never pauses.
2. As the footage plays it calibrates itself against *that footage*, usable within seconds
   and refined for its whole length.
3. Detection runs continuously, and pings appear the moment the surface changes.

There is a generated scene available if you want to poke at it before footage exists, but
it is a stand-in, not the product.

Four small, redistributable Formula Student onboard clips are bundled under
`public/footage/` for the hackathon demo. Paste one of these into **Use URL**:

- `/footage/formula-student-turn-1.mp4` (12 s)
- `/footage/formula-student-turn-2.mp4` (12 s)
- `/footage/formula-student-sun-turn.mp4` (4.5 s)
- `/footage/formula-student-chicane.mp4` (5.1 s)

They are formula-style halo/overhead camera clips, not Formula 1 broadcast
footage. Source and redistribution terms are in `public/footage/README.md`.

For AI verification, add a key first:

```bash
cp .env.example .env      # then put your ANTHROPIC_API_KEY in it
```

Without a key the CV engine runs exactly as normal and the verification card reads
`offline`. Verification is never on the critical path.

Single-process deployment:

```bash
npm run build && npm start      # serves the built app + the backend on :8787
```

The backend records the session as it runs, watches the detector while it does,
and produces a report at the end — see **[docs/BACKEND.md](docs/BACKEND.md)**. It
needs no setup: the database is a file it creates on first boot. If it is not
running, the detector behaves exactly as it did before and nothing is recorded.

---

## What it does

| | |
|---|---|
| **Analysis** | driven by frame arrival (`requestVideoFrameCallback`), with a 250 ms watchdog so a paused or stalled feed never goes silent |
| **Latency** | frame presented → result on screen, reported as p95 in the header against a 100 ms budget |
| **Signals** | specular glare, Laplacian texture variance, luma darkness, highlight spread |
| **Regions** | perspective trapezoid, split into racing line and two track edges |
| **AI verification** | every 10 s by default, off the render path, schema-constrained response |

### How the latency budget is actually met

End-to-end latency has two terms, and the second one used to dominate:

```
latency = (wait for the pipeline to look at the frame) + (work)
```

Polling at 12 Hz meant a frame landing just after a tick waited up to 83 ms before anyone
looked at it — larger than all the real work combined, for a worst case around 95 ms.

Both terms were attacked:

- **The wait is gone.** Analysis is driven by `requestVideoFrameCallback`, so a frame is
  analysed when it is presented. A 250 ms watchdog still ticks when no frames are arriving
  (paused, stalled, buffering) so the readout can never silently stop.
- **The work shrank.** The per-pixel pass now covers only the ROI's bounding box instead of
  the entire frame — on a trackside shot most of the image is sky and barriers the detector
  never samples.

The header shows the **p95 of the full path**, not the mean of the arithmetic, and turns red
above 100 ms. The pre-race check reports the same measurement, including any queueing term,
before the session starts.

---

## The pipeline

**1 — Sample.** The current frame is drawn to an offscreen canvas at 384 px wide. Every
signal is computed at this resolution; nothing needs full resolution to answer "is that
tarmac wet".

**2 — Region of interest — the road is traced, not assumed.** The lane is found
automatically every quarter second and followed. Only that surface is measured; it is
subdivided into a centre band (the racing line) and two outer bands (the track edges).
Kerbs, white lines and run-off are deliberately excluded — painted kerbing is bright and
desaturated, which reads as reflection and manufactures a false dry line. See
**[Lane tracing](#lane-tracing)** below.

**3 — Four signals**, per band, in a single pixel sweep:

| Signal | Measurement | Direction when wet |
|---|---|---|
| Specular glare | fraction of pixels that are bright *and* near-colourless | ↑ water mirrors the sky |
| Texture | variance of the 4-neighbour Laplacian | ↓ water fills the aggregate voids |
| Darkness | `1 − mean luma` | ↑ wet asphalt absorbs |
| Highlight spread | `(p95 − p50) / 255` from a luma histogram | ↑ bright reflections over a dark base |

**4 — Fusion.** Each signal is normalised 0–1 against calibrated dry and wet anchors, then
weighted into a single **wetness index**, 0–100. The normaliser is direction-agnostic, so
texture — which runs *backwards*, high when dry — needs no special case.

**5 — Classification.** The index maps to Dry / Damp / Wet through thresholds with a
hysteresis margin and a hold counter, so the label cannot strobe on a noisy feed.

**6 — The dry line.** `Drying` is not a band on the index, it is a *shape*: it fires when
the racing line reads meaningfully drier than the edges. It outranks the plain Damp/Wet
label because it is the more actionable call — it is the crossover.

**7 — Trend.** A least-squares fit over an 8-second window gives index change per minute,
which drives the tyre-strategy rules.

---

## Pre-race check — warm up before, never stall during

Everything expensive is deliberately pushed in front of the session. It runs automatically
when footage loads, and on demand from the **Pre-race check** panel:

| Check | What it proves |
|---|---|
| Feed decodes | Resolution and duration are real |
| ROI on track surface | Enough pixels land in each band for divergence to mean anything |
| Real-time calibration | Anchors and tracer thresholds derived from *this* footage while it plays — usable in seconds, refined throughout |
| Condition range | The clip actually spans dry to wet, so the index is anchored at both ends |
| Buffers warmed | Every array the hot loop touches is allocated and touched |
| Throughput | Measured ms/frame on *this* machine with *this* clip, against the 12 Hz budget |
| Verification proxy | Reachability confirmed now, not mid-session |

After it passes, the live loop **allocates nothing and never seeks** — no GC pauses, no
network on the critical path, no first-frame penalty. That's the reason a stall can't show
up at the wrong moment.

## Calibration — and the trap it avoids

Auto-calibration watches the footage as it plays — any feed, clip or live — needs no
input from you, and keeps refining for the whole session.

The obvious implementation is wrong, and wrong in a way that's hard to catch: map the
clip's 10th percentile to 0 and its 90th to 100. A purely relative scale **always** yields a
full 0–100 swing, so footage of a permanently dry track gets stretched until exposure drift
and shadows read as a rain shower. The output looks convincing and is completely fabricated
— it behaves like a scripted animation rather than a detector.

So the two ends are established differently:

- **The dry anchor is measured from your footage.** That's what absorbs camera, exposure,
  codec and daylight differences.
- **The wet anchor is derived from it by physics** — the offsets water actually produces:
  specular fraction up ~4.5 points, Laplacian texture down to ~35%, darkness up ~0.16,
  highlight spread up ~0.22.

Percentile scaling is used *only* once the clip shows real evidence it contains wet track —
and that evidence has to be **joint, per frame**: a frame counts as wet only if it is
specular *and* dark *and* low-texture at the same instant.

Testing those signals independently does not work, and real footage proved it. On an
onboard lap of a dry circuit the specular fraction ranged from **0.2% to 24%** — low sun
produces a sheen indistinguishable from water if you only look at glare, and driving in and
out of shadow swings brightness just as hard. Judged separately, every indicator fired and
a bone-dry clip was declared to span dry-to-wet.

The combination is what separates them: **water makes a surface darker, shinier and
smoother at the same moment; sun glint makes it brighter and shinier while the aggregate
stays visible.**

Onboard footage adds one more confound — at racing speed the tarmac ahead is motion-blurred,
which collapses the Laplacian exactly the way a water film does. On the dry Assen lap, 15%
of frames still cleared the joint test on blur and shadow alone. So the verdict is
three-state rather than binary:

| Share of frames meeting all three conditions | Verdict |
|---|---|
| ≥ 30% | Wet track present — anchor both ends on the footage |
| 10–30% | **Unproven** — treat as dry, anchor conservatively, say so |
| < 10% | Dry throughout |

The bias is deliberate. Under-calling water gives a cautious index; over-calling it invents
a rain shower that isn't there.

### Thresholds come from real footage, not the generated scene

The absolute wet signature was originally guessed from the synthetic scene, and it never
fired on real rain. Two onboard clips at 1280×720 through the same ROI pipeline:

| | Texture (Laplacian) | Darkness |
|---|---|---|
| Dry — Assen, sunny | 1155 – 1719 | 0.24 – 0.60 |
| Wet — Montreal, rain | **52 – 524** | 0.30 – 0.92 |

**Texture is the only signal with real separation** — better than two-to-one, no overlap —
because water fills the aggregate and the surface stops scattering. Darkness and specular
overlap between the two clips and cannot carry the decision alone. That is why thresholds
tuned on synthetic footage (specular 0.5, darkness 0.75) never matched reality, where wet
tarmac reads specular 0.04–0.22.

A uniformly wet clip is also invisible to any *relative* test, since that test asks whether
a frame is darker than the clip's own dry running and there isn't any. So each frame is
tested absolutely (smooth **and** not bright) as well as relatively.

### Why the dry anchor is the observed maximum, not a percentile

Specular glare on real footage is **bimodal**, not spread. On the dry Assen lap more than
90% of frames register *no* specular pixels inside the ROI, while the handful that catch low
sun reach 24%. A 90th-percentile dry anchor therefore sat at **zero**, every glinting frame
landed far past the wet end of the scale, and a dry lap was reported as **Wet 94/100**.

Having concluded a clip is dry, the honest anchor is *"the wettest-looking thing in it is
still dry"* — the observed extreme. After the fix, the worst sun-glint frame reads **6.8**
instead of saturating.

The report also carries which anchoring branch ran (`dry-anchored`, `wet-anchored`,
`measured-both-ends`) and the pre-race note is generated from it, so the wording can never
disagree with the maths again — that mismatch is what hid this bug.

Manual override lives in **Calibration & ROI** — park the feed on known-dry tarmac and hit
**Sample as dry**, then the same for wet.

Manual override lives in **Calibration & ROI** — park the feed on known-dry tarmac and hit
**Sample as dry**, then the same for wet. That panel also exposes the specular thresholds,
condition boundaries, hysteresis, smoothing, and verification interval.

**Aim the ROI first.** Hit **Edit ROI** and drag the four corners onto the tarmac. Sky,
barriers, kerbs or grass inside the trapezoid will poison every signal, and no amount of
threshold tuning recovers from it — painted kerbing in particular reads as reflection and
fabricates a dry line that isn't there.

## Lane tracing

The detector cannot say anything about the road until it knows which pixels *are* road.
That used to be a fixed perspective trapezoid, placed by hand or by a grid search over
candidate boxes. Both produce the same shape: straight sides, which cannot follow a corner.
On a bend that necessarily includes whatever is on the outside of it — grass, gravel, a
barrier — while missing tarmac on the inside.

That matters more here than in a lane-keeping system, because this pipeline does not just
locate the road, it **measures** it. Grass inside the region drags saturation up and texture
down; a kerb reads as standing water. A region that is 90% correct produces a confident
wetness index that is wrong, which is worse than no index at all.

So the road is traced:

1. **Seed** — candidate patches are scored on what tarmac actually is: grey, mid-bright, and
   uniform across its width. That last test is what separates road from bodywork (uniform
   but coloured) and from grass (coloured and much noisier).
2. **Grow** — from the seed, row by row, taking the contiguous run of pixels that match the
   surface. Each row's search starts from the row below it, so the corridor **follows the
   road as it bends**. Nothing about the shape is assumed.
3. **Fit** — a quadratic through each boundary. Stiff enough that one occluded row or one
   kerb cannot bend the corridor, flexible enough to describe an arc.
4. **Track** — successive traces are blended, so the corridor tracks rather than twitches.
   A corridor that moved every frame would make the racing-line band a different strip of
   tarmac each time, and the divergence signal is a comparison between two strips that are
   supposed to stay put.

### What it refuses to do

A break in the run is classified before it is tolerated, which is a physical distinction
rather than a tuned one:

| The pixel fails on | Reading | Tolerated across |
|---|---|---|
| Luma, but is still near-colourless | Paint, shadow, a wet patch — still road | ~3% of frame width |
| Saturation | A different material: grass, kerb, bodywork, gravel | 2 px |

One gap budget for both is what let a five-pixel white line split the corridor while an
eleven-pixel kerb was the thing the budget had been sized against.

The corridor is also reported **only across rows that were actually measured**. The fit is
defined over the whole search region and evaluating it there would hand back a confident
corridor covering rows where no road was ever seen — on an onboard camera, straight over the
car's own nose. Filling an interior gap is the fit doing its job; extending past both ends of
the evidence is inventing road.

And when nothing road-like is found, it returns nothing. A camera pointed at the pit garage
produces "no road", not a corridor across the wall. If the trace is lost for more than a few
seconds the backend raises an incident, because that failure has no visible symptom: the
readings keep arriving, correctly computed, over a region that is no longer the track.

### A trained model, when you want one

The tracer above is a heuristic, and a good one — but a network trained on real
driving footage finds the road through spray, at night and across patched tarmac
more reliably than any heuristic can. That is available as an optional sidecar:

| | Where it runs | Cost | Needs |
|---|---|---|---|
| **Segmentation** | Python sidecar | ~30–80 ms, up to 8×/s | a model file |
| **Geometric tracing** | browser | 0.42 ms, up to 16×/s | nothing |
| **Hand-placed ROI** | browser | free | someone to aim it |

Each falls back to the next, so nothing can leave the detector without a region.
The sidecar is optional and most installations will never run one; when it is
absent the endpoint answers "not configured" as an ordinary reply rather than an
error, and the tracer carries on.

Models come from **BDD100K** — 100k real driving videos spanning rain, night and
glare, which is the reason for choosing them over anything trained on clean
daytime footage. The domain gap to a race track is real and documented, along
with setup, calibration and fine-tuning, in **[ml/README.md](ml/README.md)**.

### Cost

| Resolution | Median | p95 |
|---|---|---|
| 384×216 (analysis resolution) | 0.42 ms | 0.63 ms |
| 640×360 | 0.95 ms | 1.17 ms |
| 960×540 | 2.01 ms | 2.21 ms |

Re-traced at most every 60 ms rather than every video frame, which comes to about
**0.28 ms per frame amortised** at 25 fps against a 100 ms budget. Neural
segmentation is a semantic keyframe; the live trace propagates its per-row
motion between responses so it does not trail the road through a turn.

`npm run test:lane` runs the tracer headlessly against synthetic roads with known geometry:
that it follows a curve rather than fitting a box, that it refuses when there is no road,
and that kerbs, markings and bodywork do not pull it off the tarmac.

**Manual override** is still there. Turn tracing off in **Calibration & ROI** and aim the
trapezoid by hand — the right answer for a camera neither automatic source can read.

### Calibrate before race day

```bash
python ml/scripts/calibrate.py footage/*.mp4 --out calibration.json
```

The browser anchors itself from a live feed in about fifteen seconds, which is
fine for a practice session and not fine for the moment the lights go out. This
measures the anchors — and the tracer's own thresholds, which were chosen against
generated scenes rather than real tarmac — from your footage, offline, so the app
starts already anchored. See [ml/README.md](ml/README.md).

The browser anchors itself from a live feed in about fifteen seconds, which is
fine for a practice session and not fine for the moment the lights go out. This
measures the anchors — and the tracer's own thresholds, which were chosen against
generated scenes rather than real tarmac — from your footage, offline. Copy the
output to `public/calibration.json` and the app imports it at startup as its
pre-warm seed, then refines from there on whatever loads. See
[ml/README.md](ml/README.md).

---

## Live feeds start immediately

Every feed calibrates the same way now: the footage plays and a progressive watch
samples what the pipeline already produces. There is no separate clip scan, and
nothing ever pauses or seeks.

It publishes anchors as soon as they are worth anything and refines them for as long
as the feed runs:

| Stage | When | What the readout means |
|---|---|---|
| `warming` | first frames | Waiting for road; nothing shown yet |
| `provisional` | ~1 s | Live, but the scale is still being established — expect the index to shift |
| `settling` | ~3 s | Usable; treat a borderline call as borderline |
| `settled` | ~15 s | Full confidence |

The stage is reported rather than hidden. A reading from second two is genuinely less certain
than one from second twenty, and saying so is what makes starting early honest rather than
merely faster. Buffers for both the analysis pass and the tracer are allocated before any of
this, so the first analysed frame costs the same as the thousandth.

## Camera angle decides what's measurable

Wetness needs one patch of road. **Drying needs to see across the track's width**, and not
every camera can.

A cockpit-mounted POV cannot: the car's own front wheels sit exactly where the track edges
would be, so the edge bands land on tyres, kerbs and grass. Comparing tarmac against a tyre
produces a confident, permanent and entirely fictional dry line.

The pre-race check detects this rather than trusting the operator to notice. Asphalt is
near-colourless, so its saturation is low and consistent across the width; grass, painted
kerbing and bodywork are not. A saturation, brightness or texture gap between the edge
bands and the racing line means they aren't the same surface — and **drying detection is
then disabled**, with the readout saying so. Wetness detection is unaffected.

| Camera | Wetness | Drying / dry line |
|---|---|---|
| Trackside, broadcast, drone | yes | yes |
| Cockpit / onboard POV | yes | no — car occludes the edges |

## Pings

The **Pit wall pings** feed is the "tell me when it changes" channel — a strategist isn't
watching the index, they're waiting to be told. It fires on:

- **Condition change** (debounced, so a borderline flicker doesn't ping twice)
- **Dry line forming** — the crossover, the call that wins track position
- **Rapid wetting** — index climbing fast enough to force a compound change
- **Pre-race check** outcomes

Optional audio ping per event; off by default.

---

## Sources

- **Video file** — drag and drop onto the feed, or use *Load footage*. This is the primary
  path: the clip loads, the pre-race check runs, and detection starts.
- **Live: screen** — capture a window, tab or screen. This is the practical route to a
  genuinely live race: point it at whatever is carrying the broadcast — a stream in another
  tab, a video wall, a timing screen — and the pipeline treats it exactly like a trackside
  camera. No ingest server, no transcoding, no RTSP plumbing.
- **Live: camera** — a webcam or phone camera, for a real trackside feed.
- **Generated scene** — a 72-second weather cycle (dry → rain → heavy → drying line → dry).
  It exists so the pipeline could be built before footage arrived and as a fallback if a
  clip misbehaves on the day. It is a stand-in, not the demo.

A looping clip is handled explicitly: when the video jumps back to the start, smoothing and
the trend window reset at the boundary and pings are suppressed briefly, so the loop seam
is never mistaken for a weather event.

**Live feeds** can't be scrubbed, so calibration watches for 20 seconds instead of scanning
a clip, and the same physics-anchored logic applies — if the track is dry while it watches,
it anchors dry and derives the wet end, rather than declaring the first passing shadow to
be rain.
- **URL** — any directly-playable video URL. Clips placed in `public/footage/` are served
  at `/footage/<name>.mp4`, which is convenient when several people need the same clip at
  the same path during a rehearsal.
- **Camera** — a live webcam, for pointing at a wet surface in the room

## Keyboard

`space` play/pause · `v` verify now · `o` toggle ROI outlines · `h` toggle heatmap

---

## AI verification

The browser posts a downscaled JPEG plus the current CV reading to `POST /api/verify`.
The server calls the Anthropic Messages API with the image and a schema-constrained
response format, so the client parses a typed object rather than prose.

- **The API key stays server-side.** That is the reason the request goes through the
  backend rather than straight out of the browser.
- The model is told what the CV engine concluded, and explicitly instructed to report what
  it actually sees rather than agree.
- Disagreement is surfaced, not hidden — the card reads *flags for review* and shows both
  calls.
- Latency is managed deliberately: low effort, one image.
- **Every attempt is recorded**, including the failures. An agreement rate computed only
  over the calls that succeeded is a survivorship-biased number, and the failures are what
  distinguish a session where the detector was checked from one where nothing was watching.

Model defaults to `claude-opus-5`; override with `PITVISION_MODEL`.

### Agreement is graded, not a yes/no

The model used to be offered `Dry | Damp | Wet | Drying | Unknown` while the engine
classifies into seven states. Every frame the engine called **Sunny**, **Greasy** or
**Flooded** was therefore recorded as a disagreement *by construction* — the model had no
way to spell the word it was being compared against, so the card read *flags for review*
on frames where both sides had seen the same thing. The enum is now the full set.

The verdict is also no longer a boolean. `Damp` against `Wet` is two people looking at the
same tarmac splitting a judgement call; `Dry` against `Flooded` is a broken detector.
Scoring them the same way buried the one that mattered, so a neighbouring band counts as
half agreement and only a real conflict counts as none.

Sustained disagreement across a session is the signal worth acting on, and it is now
watched for: the backend raises an incident when the two sides stop agreeing, because that
almost always means the calibration anchors no longer match the footage.

---

## Layout

```
src/
  cv/            the detector — lane tracing, rois, metrics, calibration, classify, engine
  strategy/      rule-based tyre call
  ai/            verification client
  telemetry/     ships the session to the backend; fire-and-forget, off the hot path
  source/        feed management + the synthetic scene generator
  ui/            overlay, trend chart, condition strip, particles, calibration panel
  styles/        design tokens + application styling
server/          the backend — recording, monitoring, reporting  (docs/BACKEND.md)
scripts/
  smoke.mjs      end-to-end API test
  lane-test.mjs  lane tracer, headless, against synthetic roads
  roi-test.mjs   proves nothing outside the road reaches the sampler
ml/            optional road segmentation, calibration and fine-tuning (ml/README.md)
```

## Tests

```bash
npm test        # typecheck + 21 lane + 12 ROI-isolation + 83 API checks
npm run test:ml # 107 Python checks: mask→corridor, ONNX path, HTTP, calibration
npm run test:all
```

`window.pitvision` exposes the engine, source and calibration in the console for
debugging, plus `repaint()`.

## Design notes worth knowing

**One source of truth for events.** The ping feed keys off the classifier's committed
label, never a second set of thresholds. An earlier version watched the divergence directly
and flapped — on a near-dry track a racing line of 1 against edges of 10 clears a 9-point
gap and fired "dry line forming" repeatedly while the headline still read Dry. The feed can
now never contradict the readout.

**No circular self-checks.** The pre-race check reports *which signals varied across the
clip*, not the span between the calibrated anchors. The latter is always "0 to 100" by
construction, because the anchors are defined as the ends of that range — a check that
always passes is not a check.

**Honest latency.** The header times the full path — frame upload, pixel readback and
analysis — not just the arithmetic. On a video source, decoding the frame is the expensive
part, and timing only the maths would flatter the figure by roughly 10×.
