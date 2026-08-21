# Changelog — decisions and changes

A running record of what is being changed in this codebase, why, and what was
deliberately *not* changed. Newest first. Each entry names its files and how it
was verified, so a future reader can tell a decision from an accident.

---

## 2026-08-21 — Real-time calibration replaces the 40-frame seek-scan

### 1. Calibration now runs on the footage as it plays, for its whole length

**Change.** Removed `autoCalibrateClip` (the pre-race check used to pause
playback and seek-scan 40 sampled frames end to end) and the fixed 20-second
blocking live watch. Both are replaced by one function,
`autoCalibratePlayback()` in `src/cv/autocal.ts`: it samples the pipeline while
the footage simply plays, publishes usable anchors after ~4 road frames,
refines them continuously, and labels each publication with a stage
(`warming → provisional → settling → settled`) instead of pretending they are
equally certain.

- Clips and live feeds now share one code path — there is no longer a
  seekable/non-seekable branch in `runPreRaceCheck`.
- Because nothing seeks any more, `preRace()` in `src/main.ts` no longer stops
  the engine or sets `source.seeking`; the readout never blanks during the
  check, and history/trend accumulated during those seconds stays valid.
- The check hands back at the first usable anchors (or after a 15 s give-up if
  no road ever appears) and keeps refining through `onRefine`
  (renamed from `onLiveRefine`) for the rest of the footage.
- After the anchors settle, republish cadence drops to every ~32 samples
  (~8 s) so the index does not twitch under the reader.

**Why.** The scan answered "what did this clip contain" but cost a frozen
readout every upload, and its 40 point samples ignored everything between
cells. Watching the real playback measures the same footage without stealing
the UI, converges to the same anchors, and keeps improving if conditions change
mid-session.

### 2. Full-bundle presets: tracer thresholds join the anchors

**Change.** Ported `tracer_thresholds()` from `ml/scripts/calibrate.py`
(`maxSat = clamp(p98(sat)·1.35, 0.18..0.42)`,
`lumaTolerance = clamp((p95−p05)(luma)·0.75, 30..90)`) into the browser as
`tracerFrom()` in `autocal.ts`, measured from per-frame road-band saturation
and luma. Reports carry `AutoCalReport.tracer`; `Calibration` gained
`traceMaxSat` / `traceLumaTolerance` (defaults stay pinned to
`DEFAULT_TRACE_OPTIONS`), persisted through the existing localStorage key, and
`CvEngine.setCalibration` writes them into `LaneTracker.options`. The
calibration panel exposes both sliders next to the ROI controls.

Applied only once ≥12 surface samples exist; thresholds ride along at the next
natural retrace rather than forcing a corridor jump.

**Why.** These constants were picked against generated grey roads; real tarmac
(patch repairs, sun bleaching, rubbered-in lines) needs wider admission. They
are exactly the kind of thing that should be measured per footage like the
anchors already are.

### 3. `/calibration.json` auto-loads at startup

**Change.** New `src/cv/prewarm.ts`: fetches `/calibration.json` once at
startup, validates shape (`dry`/`wet` signals required; optional `glareV`,
`glareS`, `tracer.{maxSat,lumaTolerance}` accepted), merges into the current
calibration before any footage loads, and toasts when found. Silent no-op when
the file is absent — that is the normal case, not an error.

Drop location: `public/calibration.json` (served by vite dev and copied into
`dist/` for production; already gitignored). `ml/scripts/calibrate.py`'s final
hint now says this instead of pointing at the non-existent "Import" button.

**Why.** The offline tool's output previously had no consumer. A seed means the
first frames of a fresh clip are scored against measured numbers instead of the
synthetic-scene defaults, and the in-app watch refines from there.

### Deliberately not automated

- **Glare V/S cutoffs and condition boundaries** (`dampAt`, `wetAt`,
  `hysteresis`, `holdTicks`, `smoothing`, `divergenceAt`) stay operator policy.
  Deriving glare cutoffs mid-watch would invalidate the anchor samples
  accumulated under the old cutoffs (feedback loop); condition boundaries live
  in index space and cannot be honestly derived from footage without ground
  truth. The repo's own rule applies: a check that always passes is not a
  check.
- `SourceManager.seeking` flag kept: it still guards loop-restart detection
  against manual user seeks; nothing sets it programmatically any more.

### Files

`docs/CHANGES.md` · `src/cv/autocal.ts` · `src/cv/calibration.ts` ·
`src/cv/engine.ts` · `src/cv/prerace.ts` · `src/cv/prewarm.ts` (new) ·
`src/main.ts` · `src/ui/panels.ts` · `ml/scripts/calibrate.py` · `README.md`

### Verification

`npm test` — typecheck (app + server) ✓, lane 25/25, roi 12/12, trend 8/8,
smoke 83/83. Also required `npm install` first: `@types/node` was declared in
devDependencies but missing from `node_modules` (stale install on this machine,
unrelated to these changes).

---

## Real-time Track Edge, Horizon Calibration & Headcam Full-Width Mapping

**Problem.** On onboard and cockpit headcam footage, the lane tracer was previously dropping below the car nosecone ($y > 0.65$) and seeding inside the narrow gap between the left wheel and the blue nosecone. This caused the container to trace the triangular gap beside the tyre, resulting in:
1. The container being trapped exclusively on the left side of the car, treating the car's nosecone as the track's right edge.
2. The container tapering towards the bottom (following the narrowing gap between the wheel and sidepod) instead of perspective widening.
3. `RACING LINE` sampling the left suspension arm/tyre and `EDGE R` sampling the nosecone livery, corrupting wetness signals and triggering false "flooded" / "prepare wets" calls.

**Change.**
1. **Open Track Seeding Ahead of Car Hood**: `findSeed` in `src/cv/lane.ts` now searches strictly in the mid-depth road zone ($y \in [opts.searchTop, 0.56]$) ahead of the vehicle hood. It enforces a full-width road span test ($l \le 0.38$ and $r \ge 0.62$), penalising and rejecting candidates trapped to one side of the car.
2. **Car Hood Boundary Termination ($y_{bottom}$)**: Downward row scanning terminates the instant central pixels hit the car nosecone / livery / bodywork ($y \approx 0.52 - 0.60$), ensuring $y_{bot}$ sits cleanly **beyond the hood of the car**.
3. **Horizon Boundary Termination ($y_{top}$)**: Upward row scanning terminates at the road vanishing point / horizon ($y_{top} \approx 0.34$), matching the visible road span.
4. **Full-Width Perspective Geometry**: Left boundary $l(y)$ spans from the left of the car ($x \approx 0.05 - 0.25$) and right boundary $r(y)$ spans to the right of the car ($x \approx 0.75 - 0.95$), properly widening towards the foreground ($W \approx 0.75$ at bottom, $W \approx 0.20$ at horizon).
5. **Accurate Strategy & Divergence**: `EDGE L` now samples the left track margin, `RACING LINE` samples the central driving line ahead of the car, and `EDGE R` samples the right track margin.

### Files

`src/cv/lane.ts` · `src/cv/prerace.ts` · `scripts/lane-test.mjs` · `docs/CHANGES.md`

### Verification

`npx tsc --noEmit` ✓, `lane-test.mjs` (28/28 passed) ✓, `roi-test.mjs` (12/12 passed) ✓, `trend-test.mjs` (8/8 passed) ✓.

---

## Backlog (agreed priorities, unchanged)

1. **Stand up the segmentation path end to end** before judging edge quality:
   `.venv` → `fetch_models.py --model yolopv2` → sidecar →
   `PITVISION_SEGMENTER_URL`; install `onnxruntime-gpu` (RTX 4060).
   `engine.ts` priority chain (manual → segmentation → traced → manual) and
   `segclient` (400 ms interval, give-up after 4 misses) already support it.
2. **Fine-tune only if needed**: if run-off bleeding appears at edges,
   `prepare_dataset.py` → review → `finetune.py` (0.5 M-param U-Net).
3. Deprioritised: SUB_BANDS ratio tuning, Opus→HF verification swap (stay on
   YOLOPv2/TwinLiteNet ONNX path rather than HF transformers).
