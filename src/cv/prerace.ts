import type { CvEngine } from './engine';
import type { FrameMetrics } from '../types';

type FrameMetricsLike = Pick<FrameMetrics, 'road'>;
import type { Calibration } from './calibration';
import type { RoadGeometry } from './rois';
import type { SourceManager } from '../source/manager';
import {
  autoCalibrateClip,
  autoCalibrateLiveProgressive,
  applyReport,
  type AutoCalReport,
  type LiveCalUpdate,
} from './autocal';
import { warmUp } from './metrics';
import { warmUpLane } from './lane';
import { wetnessIndex, inertSignals } from './calibration';
import { toSignals } from './metrics';

export type CheckState = 'pending' | 'running' | 'pass' | 'warn' | 'fail';

export interface Check {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
}

export interface PreRaceResult {
  checks: Check[];
  calibration: Calibration | null;
  report: AutoCalReport | null;
  ok: boolean;
}

export type CheckListener = (checks: Check[]) => void;

export interface PreRaceOptions {
  calibrate?: boolean;
  /**
   * Called when a live feed's anchors are refined *after* the check returned.
   *
   * A live pre-race check does not wait for the full watch — see the calibration
   * step below. It hands back usable anchors as soon as they exist so the
   * readout starts, then keeps improving them through this callback.
   */
  onLiveRefine?: (calibration: Calibration, update: LiveCalUpdate) => void;
}

/**
 * Cancels the background watch left running by a previous live check.
 *
 * Without this, loading a second feed leaves the first one's watch sampling the
 * new footage and overwriting its anchors from behind — the calibration would
 * be a blend of two different roads with nothing on screen to say so.
 */
let liveWatch: { aborted: boolean } | null = null;

/**
 * Find the tarmac automatically.
 *
 * The default ROI assumes a trackside camera, where road fills the lower half.
 * On a cockpit or onboard camera the lower half is the car — bodywork, wheels,
 * the driver's hands — and sampling it produces confident readings of a Ferrari
 * rather than a race track. Since onboard is the footage people actually have,
 * the ROI cannot be left as a default the user is expected to know to fix.
 *
 * Asphalt's giveaway is that it is *grey*: near-zero saturation at moderate
 * brightness. Car liveries, kerbs, grass and sky are all strongly coloured, and
 * the sky is bright as well. So candidate bands are scored on low saturation
 * first, with brightness kept mid-range and a texture floor to reject blown-out
 * or pitch-black regions.
 */
export function findRoad(engine: CvEngine, cal: Calibration): RoadGeometry | null {
  const original = cal.road;
  let best: { road: RoadGeometry; score: number } | null = null;

  // Candidate bands: where the road sits vertically, and how wide it is.
  for (const yTop of [0.28, 0.34, 0.40, 0.46, 0.52, 0.58, 0.64]) {
    for (const height of [0.08, 0.13, 0.2, 0.3]) {
      const yBot = yTop + height;
      if (yBot > 0.98) continue;
      for (const halfWidth of [0.09, 0.15, 0.24]) {
        const road: RoadGeometry = {
          yTop,
          yBot,
          xTopL: 0.5 - halfWidth * 0.62,
          xTopR: 0.5 + halfWidth * 0.62,
          xBotL: 0.5 - halfWidth,
          xBotR: 0.5 + halfWidth,
        };
        cal.road = road;
        const m = engine.probe();
        if (!m || m.road.pixels < 350) continue;

        const b = m.road;
        // Grey wins. Mid-brightness wins. Featureless wins nothing.
        const greyness = 1 - Math.min(1, b.sat / 0.35);
        const brightness = 1 - Math.min(1, Math.abs(b.luma - 118) / 118);
        const alive = b.texture > 25 ? 1 : 0.15;
        const score = greyness * 0.6 + brightness * 0.3 + alive * 0.1;
        if (!best || score > best.score) best = { road, score };
      }
    }
  }

  cal.road = original;
  // Below this the frame simply does not contain an obvious road surface.
  return best && best.score > 0.55 ? best.road : null;
}

/**
 * The pre-race check.
 *
 * Everything expensive, seekable, allocating or network-bound happens here,
 * before the session starts — decode, ROI validation, a full-clip calibration
 * sweep, buffer warm-up, a timed throughput probe, and the verification
 * proxy handshake. Once this passes, the live loop does nothing but read
 * pixels out of pre-allocated arrays, so the readout has no reason to stall
 * mid-session.
 *
 * It is also the honest answer to "how do you know it works on this footage" —
 * every claim below is measured against the actual clip.
 */
export async function runPreRaceCheck(
  source: SourceManager,
  engine: CvEngine,
  cal: Calibration,
  onUpdate: CheckListener,
  opts: PreRaceOptions & { checkProxy?: boolean } = {},
): Promise<PreRaceResult> {
  const options = opts;
  const calibrate = opts.calibrate ?? true;
  const checkProxy = opts.checkProxy ?? true;

  const checks: Check[] = [
    { id: 'feed', label: 'Feed decodes', state: 'pending', detail: '' },
    { id: 'roi', label: 'ROI on track surface', state: 'pending', detail: '' },
    { id: 'bands', label: 'Edge bands see the same surface', state: 'pending', detail: '' },
    { id: 'calib', label: 'Calibration sweep', state: 'pending', detail: '' },
    { id: 'range', label: 'Signal spread across clip', state: 'pending', detail: '' },
    { id: 'warm', label: 'Buffers warmed', state: 'pending', detail: '' },
    { id: 'speed', label: 'Throughput', state: 'pending', detail: '' },
    { id: 'proxy', label: 'Verification proxy', state: 'pending', detail: '' },
  ];

  const set = (id: string, state: CheckState, detail: string) => {
    const c = checks.find((x) => x.id === id)!;
    c.state = state;
    c.detail = detail;
    onUpdate([...checks]);
  };

  let calibration: Calibration | null = null;
  let report: AutoCalReport | null = null;
  let divergenceReliable = true;

  // 1 — Feed decodes.
  set('feed', 'running', 'checking…');
  if (!source.ready || !source.width) {
    set('feed', 'fail', 'No decodable frames. Load a clip first.');
    return { checks, calibration, report, ok: false };
  }
  const dur = source.seekable ? ` · ${source.videoDuration.toFixed(1)}s` : '';
  set('feed', 'pass', `${source.width}×${source.height}${dur}`);

  // 2 — The region actually lands on road.
  //
  //     With tracing on, this is a check rather than a search: the tracer has
  //     already located the road and is following it, and the job here is to
  //     confirm it locked on before the session starts, not to place a shape.
  //     With tracing off, the old grid search still positions the hand-placed
  //     trapezoid — otherwise onboard footage silently gets measured on the car.
  set('roi', 'running', cal.laneAuto ? 'tracing the road…' : 'locating tarmac…');
  let probe = engine.probe();
  const looksLikeRoad = (m: FrameMetricsLike | null) =>
    !!m && m.road.pixels >= 400 && m.road.sat < 0.2 && m.road.luma > 25 && m.road.luma < 215;

  let moved = false;
  let traced = false;

  if (cal.laneAuto) {
    // Give the tracer a few frames to settle. It rate-limits itself, so a
    // single probe would usually be the very first attempt.
    for (let i = 0; i < 6 && !engine.lane.trace; i++) {
      engine.lane.invalidate();
      probe = engine.probe();
    }
    traced = engine.lane.trace !== null;

    if (!traced) {
      // The tracer found nothing road-like. Rather than run without a region,
      // fall back to the search that placed the fixed trapezoid, and say so —
      // a corridor that could not be traced is exactly the case where someone
      // needs to look at the overlay themselves.
      const found = findRoad(engine, cal);
      if (found) {
        cal.road = found;
        calibration = { ...cal, road: found };
        probe = engine.probe();
        moved = true;
      }
    }
  } else if (!looksLikeRoad(probe)) {
    const found = findRoad(engine, cal);
    if (found) {
      cal.road = found;
      calibration = { ...cal, road: found };
      probe = engine.probe();
      moved = true;
    }
  }

  if (!probe || probe.road.pixels < 400) {
    set('roi', 'fail', `Only ${probe?.road.pixels ?? 0} px inside the region. Use Edit ROI and drag the corners onto the tarmac.`);
    return { checks, calibration, report, ok: false };
  }
  if (!looksLikeRoad(probe)) {
    set('roi', 'warn',
      `The sampled region does not look like tarmac (saturation ${probe.road.sat.toFixed(2)}, brightness ` +
      `${probe.road.luma.toFixed(0)}) and no better one was found. It is probably on the car, ` +
      `sky or grass — use Edit ROI. Readings until then are meaningless.`);
  }
  const linePx = probe.line.pixels;
  const edges = probe.left.pixels + probe.right.pixels;

  const lane = engine.lane.trace;
  const where = traced && lane
    ? `road traced · ${(lane.meanWidth * 100).toFixed(0)}% of frame width · ` +
      `${(lane.confidence * 100).toFixed(0)}% of rows measured · `
    : moved
      ? 'no lane traced, fixed ROI placed automatically · '
      : '';

  if (looksLikeRoad(probe)) {
    if (linePx < 150 || edges < 150) {
      set('roi', 'warn', `${where}thin bands (line ${linePx} px, edges ${edges} px). Divergence will be noisy.`);
    } else {
      set('roi', 'pass', `${where}${probe.road.pixels} px sampled · line ${linePx} · edges ${edges}`);
    }
  }

  // 2b — Are the edge bands looking at the same material as the racing line?
  //
  //      Asphalt is near-colourless, so its saturation is low and consistent
  //      across the track's width. Grass, painted kerbing and car bodywork are
  //      not, and each shows up here: a saturation or brightness gap between
  //      the bands means they are not sampling the same surface, and any
  //      divergence measured between them would be an artefact of the camera
  //      angle rather than a dry line. Cockpit-mounted cameras fail this by
  //      construction — the front wheels sit where the track edges would be.
  set('bands', 'running', 'comparing…');
  const lineBand = probe.line;
  const worst = [probe.left, probe.right]
    .map((b) => ({
      sat: Math.abs(b.sat - lineBand.sat),
      luma: Math.abs(b.luma - lineBand.luma),
      texRatio: lineBand.texture > 0 ? b.texture / lineBand.texture : 1,
    }))
    .reduce((a, b) => (b.sat > a.sat ? b : a));

  const mismatched =
    worst.sat > 0.08 || worst.luma > 45 || worst.texRatio < 0.35 || worst.texRatio > 2.8;
  divergenceReliable = !mismatched;
  if (mismatched) {
    set('bands', 'warn',
      `Edge bands don't match the racing line (saturation Δ${worst.sat.toFixed(2)}, ` +
      `brightness Δ${worst.luma.toFixed(0)}, texture ×${worst.texRatio.toFixed(2)}). ` +
      `They are probably on kerbs, grass or the car itself — common on cockpit cameras. ` +
      `Drying detection is disabled; wetness detection is unaffected.`);
  } else {
    set('bands', 'pass',
      `Consistent surface across the width (saturation Δ${worst.sat.toFixed(2)}, ` +
      `brightness Δ${worst.luma.toFixed(0)}). Drying detection enabled.`);
  }

  // 3 — Calibration.
  //
  //     A clip is scanned end to end, because it is not going anywhere and the
  //     whole of it is available now.
  //
  //     A live feed cannot be scanned — there is no "end" yet — so it is
  //     watched instead. The watch used to block for twenty seconds and return
  //     nothing until it finished, which on a live feed means twenty seconds of
  //     a race happening behind a blank readout. It now returns as soon as the
  //     anchors are worth anything and keeps refining them behind the session,
  //     with the stage saying how far along it is: a reading from second two is
  //     genuinely less certain than one from second twenty, and saying so is
  //     what makes starting early honest rather than merely quicker.
  if (calibrate) {
    set('calib', 'running', source.seekable ? 'scanning clip…' : 'watching feed…');
    try {
      if (source.seekable) {
        report = await autoCalibrateClip(source.video, engine, 40, (d, t) =>
          set('calib', 'running', `frame ${d}/${t}`));
        calibration = { ...applyReport(cal, report), divergenceReliable, signature: source.signature };
        set('calib', report.confident ? 'pass' : 'warn', report.note);
      } else {
        liveWatch?.aborted !== undefined && (liveWatch.aborted = true);
        const watch = { aborted: false };
        liveWatch = watch;

        report = await new Promise<AutoCalReport | null>((resolve) => {
          let handedBack = false;

          void autoCalibrateLiveProgressive(
            engine,
            (u) => {
              if (u.stage === 'warming') {
                set('calib', 'running', u.note);
                return;
              }

              const next: Calibration = {
                ...applyReport(cal, u.report),
                divergenceReliable,
                signature: source.signature,
              };
              set('calib', u.stage === 'settled' ? 'pass' : 'warn', u.note);

              if (!handedBack) {
                handedBack = true;
                calibration = next;
                resolve(u.report);
              } else if (!watch.aborted) {
                // The check has already returned; push refinements to the app.
                options.onLiveRefine?.(next, u);
              }
            },
            { signal: watch },
          ).then(() => {
            // The watch ended without ever producing usable anchors — no road,
            // or the feed stopped. Unblock rather than hang the check.
            if (!handedBack) resolve(null);
          });
        });
      }
    } catch (err) {
      set('calib', 'warn', err instanceof Error ? err.message : String(err));
    }
  } else {
    calibration = { ...cal, divergenceReliable };
    set('calib', 'pass', 'Skipped — using existing anchors.');
  }

  // 4 — Did the clip actually exercise each signal?
  //
  //     Note what this does *not* do: comparing the calibrated anchors against
  //     each other would always come back "spans 0 to 100", because the anchors
  //     are by construction the ends of that range. That is circular. The only
  //     non-circular question is which signals moved enough to be calibrated
  //     from the footage and which fell back to a physical default.
  const active = calibration ?? cal;
  if (report) {
    const g = report.spread.glare;
    const d = report.spread.darkness;
    const numbers =
      `Glare ${(g[0] * 100).toFixed(1)}→${(g[1] * 100).toFixed(1)}%, ` +
      `darkness ${d[0].toFixed(2)}→${d[1].toFixed(2)}.`;
    // Report the branch that actually ran, so the wording and the anchoring can
    // never drift apart.
    const inert = inertSignals(active);
    const inertNote = inert.length
      ? ` ${inert.join(', ')} shows no span on this feed and is excluded from the index; ` +
        `the remaining ${4 - inert.length} carry it.`
      : '';
    set('range', report.confident ? 'pass' : 'warn',
      `[${report.branch}] ${report.note} ${numbers}${inertNote}`);
  } else {
    const now = wetnessIndex(toSignals(probe.road), active);
    set('range', 'warn', `Not measured. Current frame reads ${now.toFixed(0)} on the index.`);
  }

  // 5 — Pre-allocate everything the hot loop touches.
  set('warm', 'running', 'allocating…');
  warmUp(engine.sampleWidth, engine.sampleHeight || 216);
  // The tracer has its own buffers and they are allocated on its first trace,
  // which would otherwise land in the middle of a live session.
  warmUpLane(engine.sampleWidth, engine.sampleHeight || 216);
  for (let i = 0; i < 5; i++) engine.probe();
  set('warm', 'pass', 'Analysis and lane-tracing buffers allocated and touched.');

  // 6 — Timed throughput on this machine, with this footage.
  //
  //     Measured against the 100 ms end-to-end requirement, not against the
  //     sampling interval. Frame-driven sources add no queueing delay on top of
  //     this; polled ones add up to one interval, which is accounted for here.
  set('speed', 'running', 'timing…');
  const runs = 25;
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) engine.probe();
  const per = (performance.now() - t0) / runs;
  const frameDriven = !source.usingSynthetic && source.kind !== 'none';
  // Worst-case staleness: one capped analysis gap, then one pass.
  const queueing = frameDriven ? 40 : 50;
  const worstCase = per + queueing;
  const how = frameDriven
    ? `frame-driven, +${queueing} ms worst-case gap`
    : `polled at 20 Hz, +${queueing} ms worst-case wait`;

  if (worstCase > 100) {
    set('speed', 'fail', `${worstCase.toFixed(0)} ms worst case exceeds the 100 ms budget (${per.toFixed(1)} ms work, ${how}).`);
  } else if (worstCase > 60) {
    set('speed', 'warn', `${worstCase.toFixed(0)} ms worst case — inside 100 ms but tight (${per.toFixed(1)} ms work, ${how}).`);
  } else {
    set('speed', 'pass', `${per.toFixed(1)} ms/frame · ${worstCase.toFixed(0)} ms worst case end to end · ${how}.`);
  }

  // 7 — Verification proxy, checked now rather than mid-session.
  if (checkProxy) {
    set('proxy', 'running', 'pinging…');
    try {
      const res = await fetch('/api/health');
      const j = (await res.json()) as { configured: boolean; model: string };
      if (j.configured) set('proxy', 'pass', `Ready — ${j.model}`);
      else set('proxy', 'warn', 'Running, but ANTHROPIC_API_KEY is not set. CV is unaffected.');
    } catch {
      set('proxy', 'warn', 'Unreachable. CV runs regardless; verification will stay offline.');
    }
  } else {
    set('proxy', 'pass', 'Skipped.');
  }

  const ok = !checks.some((c) => c.state === 'fail');
  return { checks, calibration, report, ok };
}
