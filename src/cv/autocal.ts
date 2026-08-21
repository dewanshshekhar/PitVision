import type { Signals } from '../types';
import { toSignals } from './metrics';
import type { CvEngine } from './engine';
import type { Calibration } from './calibration';

export interface AutoCalReport {
  dry: Signals;
  wet: Signals;
  samples: number;
  /** False when the clip barely varies, so the anchors were not trusted. */
  confident: boolean;
  /** Signals that showed too little variation and kept a physical default. */
  weak: (keyof Signals)[];
  /** Observed low/high of each signal across the clip, for reporting. */
  spread: Record<keyof Signals, [number, number]>;
  /** Which anchoring path ran. Reported so the verdict can never disagree with it. */
  branch: 'measured-both-ends' | 'dry-anchored' | 'wet-anchored';
  note: string;
  /**
   * Lane-tracer thresholds measured from the same footage, once enough surface
   * samples exist. Absent before that — the defaults hold until they don't.
   */
  tracer?: TracerThresholds;
}

/**
 * How a wet surface differs from the same surface dry, as offsets from a
 * measured dry baseline rather than absolute values. Anchoring this way keeps
 * the camera, exposure and codec factored out — those all move the dry
 * baseline, and water moves the signal *relative to* it.
 */
const WET_OFFSET = {
  /** Specular pixels as a fraction of the ROI. Matte asphalt produces almost none. */
  glareAdd: 0.045,
  /** Water fills the aggregate voids; the Laplacian collapses to roughly a third. */
  textureRatio: 0.35,
  /** Wet asphalt absorbs: darkness climbs by this much on a 0..1 scale. */
  darknessAdd: 0.16,
  /** Bright reflections open a gap between the highlights and the base surface. */
  specularAdd: 0.22,
};

/**
 * Evidence that a clip actually contains wet track.
 *
 * These have to be tested *jointly, per frame* rather than as independent
 * signals over the whole clip. Sunlit dry asphalt trips every one of them
 * separately: low sun produces a specular sheen, and driving through shadow
 * and back swings the brightness hard. Measured on real onboard footage of a
 * dry circuit, the specular fraction ranged from 0.2% to 24% — a clip with no
 * water anywhere would have been called wet.
 *
 * What separates them is the *combination*. Water makes a surface darker and
 * shinier and smoother at the same instant. Sun glint makes it brighter and
 * shinier while the aggregate stays visible. So a frame only counts as wet if
 * it is simultaneously specular, dark, and low-texture.
 */
const WET_EVIDENCE = {
  /** Specular fraction within a single frame. */
  glare: 0.015,
  /** How much darker than the clip's brightest tarmac that same frame must be. */
  darknessAbove: 0.06,
  /** Texture must have collapsed relative to the clip's most textured frames. */
  textureBelow: 0.6,
  /**
   * Share of frames that must qualify before percentile scaling is trusted.
   *
   * Set high because onboard footage has one more confound: at racing speed the
   * tarmac ahead is motion-blurred, which collapses the Laplacian exactly the
   * way a water film does. On a dry lap of Assen 15% of frames cleared the
   * joint test on blur plus shadow alone. Anything between the two thresholds
   * is treated as unproven and falls back to physics anchoring — the failure
   * mode of under-calling water is a cautious index, and the failure mode of
   * over-calling it is inventing a rain shower.
   */
  confidentShare: 0.3,
  /** Below this, the clip is confidently dry rather than merely unproven. */
  noneShare: 0.1,
  /** Above this the clip never shows dry track, so the wet end is the measured one. */
  soakedShare: 0.85,
};

/**
 * Absolute signature of a water film, measured on real footage rather than
 * guessed from the generated scene.
 *
 * Two onboard clips at the same 1280×720, run through the same ROI pipeline:
 *
 *   dry (Assen, sunny)   texture 1155–1719   darkness 0.24–0.60
 *   wet (Montreal, rain) texture   52– 524   darkness 0.30–0.92
 *
 * Texture is the discriminator with real separation — better than two-to-one
 * with no overlap — because water fills the aggregate and the surface stops
 * scattering. Darkness and specular overlap between the two clips and cannot
 * carry the decision on their own, which is why the earlier thresholds, tuned
 * against synthetic footage, never fired on real rain.
 *
 * These are absolute because the analysis resolution is fixed at 384px wide.
 * Heavy compression or a very soft lens lowers texture on dry track too, so
 * darkness is required alongside it.
 */
const WET_ABSOLUTE = {
  /** Laplacian variance at or below this is a mirrored surface, not aggregate. */
  texture: 900,
  /** And it must not be bright — sun-bleached dry tarmac sits well below this. */
  darkness: 0.28,
};

const KEYS: (keyof Signals)[] = ['glare', 'texture', 'darkness', 'specular'];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** The lane tracer's own admission constants, measured per footage. */
export interface TracerThresholds {
  /** How colourful a pixel may be and still count as tarmac. */
  maxSat: number;
  /** How far a row's brightness may drift from the reference and still match. */
  lumaTolerance: number;
}

/** One frame's road-band surface reading, feeding the threshold measurement. */
export interface SurfaceSample {
  sat: number;
  luma: number;
}

/**
 * Measure the lane tracer's constants from observed road pixels.
 *
 * Ported from ml/scripts/calibrate.py's tracer_thresholds(). Both sets of
 * constants were originally picked against generated scenes — uniform grey
 * roads, which real tarmac is not. Patched repairs, sun bleaching,
 * rubbered-in racing lines and standing water all widen the distribution, and
 * a tolerance set on a synthetic road clips the corridor on a real one.
 *
 * Measured from the road band the detector already samples, so what the
 * thresholds admit is exactly what the rest of the pipeline has been reading.
 */
export function tracerFrom(samples: SurfaceSample[]): TracerThresholds {
  const sats = samples.map((s) => s.sat).sort((a, b) => a - b);
  const lumas = samples.map((s) => s.luma).sort((a, b) => a - b);

  // Admit almost all observed road saturation, with headroom — but never so
  // much that vegetation would pass. 0.45 is where grass starts on real
  // footage, so the ceiling sits below it whatever the measurement says.
  const maxSat = Math.min(0.42, Math.max(0.18, percentile(sats, 0.98) * 1.35));

  // Brightness spread between frames is a lower bound on the spread *within*
  // a frame, which is what the row-to-row tolerance has to survive.
  const lumaSpread = percentile(lumas, 0.95) - percentile(lumas, 0.05);
  const lumaTolerance = Math.min(90, Math.max(30, lumaSpread * 0.75));

  return { maxSat: round(maxSat, 4), lumaTolerance: round(lumaTolerance, 1) };
}

/**
 * Turn per-frame samples into dry/wet anchors.
 *
 * The obvious approach — map the clip's 10th percentile to 0 and its 90th to
 * 100 — is wrong, and wrong in a way that is hard to notice. A purely relative
 * scale *always* produces a full 0–100 swing, so a clip of a permanently dry
 * track gets stretched until exposure drift and shadows read as a rain shower.
 * The output looks convincing and is entirely fabricated.
 *
 * So the two ends are established differently. The dry anchor is measured from
 * the footage, which is what absorbs camera, exposure and codec differences.
 * The wet anchor is derived from it by the physical offsets water actually
 * produces. A clip with no water then reads near zero throughout, which is the
 * correct answer. Percentile scaling is used only once the clip has shown
 * absolute evidence that it really does contain wet track.
 */
function anchorsFrom(samples: Signals[]): AutoCalReport {
  const spread = {} as Record<keyof Signals, [number, number]>;
  const p = {} as Record<
    keyof Signals,
    { min: number; lo: number; mid: number; hi: number; max: number }
  >;

  for (const key of KEYS) {
    const sorted = samples.map((s) => s[key]).sort((a, b) => a - b);
    p[key] = {
      min: sorted[0],
      lo: percentile(sorted, 0.1),
      mid: percentile(sorted, 0.5),
      hi: percentile(sorted, 0.9),
      max: sorted[sorted.length - 1],
    };
    spread[key] = [p[key].min, p[key].max];
  }

  // Does this footage contain wet track at all?
  //
  // Counted per frame and jointly: specular *and* dark *and* smooth together.
  // Any one of those alone is satisfied by a dry track in low sun.
  const darkThreshold = p.darkness.lo + WET_EVIDENCE.darknessAbove;
  const textureThreshold = p.texture.hi * WET_EVIDENCE.textureBelow;
  const wetFrames = samples.filter(
    (s) =>
      // Absolute: smooth and not bright. Catches a clip that is wet from end to
      // end, which the relative test below structurally cannot — it asks
      // whether a frame is darker than this clip's own dry running, and a
      // soaked clip has no dry running to be darker than.
      (s.texture <= WET_ABSOLUTE.texture && s.darkness >= WET_ABSOLUTE.darkness) ||
      // Relative: specular, darker and smoother than this clip's dry end.
      (s.glare >= WET_EVIDENCE.glare &&
        s.darkness >= darkThreshold &&
        s.texture <= textureThreshold),
  ).length;
  const wetShare = wetFrames / samples.length;

  // One measurement decides all three branches.
  //
  // An earlier version decided "does this clip contain wet track" from a joint
  // per-frame test, and then decided "is it uniformly wet" from a *separate*
  // test on the medians. Those two disagreed: on a dry lap the joint test
  // correctly found no wet frames, while the median test saw a bright specular
  // median and declared the whole clip wet — so the report read "wet track not
  // proven" while the anchors were being set as if it were soaked, and the
  // readout called a dry track Wet. A clip cannot both contain no wet frames
  // and be uniformly wet; deriving every branch from one number makes that
  // contradiction unrepresentable.
  // A uniformly wet clip is invisible to the joint test: that test asks whether
  // a frame is darker than the clip's own dry end, and a soaked clip has no dry
  // end to be darker than. So it is recognised separately, on absolute
  // properties of the median frame — reflective, dark and glossy at once.
  // All three must hold: the dry Assen lap clears the glare threshold on its
  // own but sits nowhere near the darkness or highlight-spread ones.
  // Tested on the *driest decile*, not the median. "Wet throughout" means even
  // the driest-looking frames in the clip are wet; a median test instead fires
  // on a clip that transitions from dry to wet, because its middle frame sits
  // in the middle of the transition.
  const soakedByAbsolute =
    p.texture.hi <= WET_ABSOLUTE.texture && p.darkness.mid >= WET_ABSOLUTE.darkness;
  const soaked = wetShare > WET_EVIDENCE.soakedShare || soakedByAbsolute;
  const hasWet = !soaked && wetShare >= WET_EVIDENCE.confidentShare;
  const ambiguous = !hasWet && !soaked && wetShare > WET_EVIDENCE.noneShare;

  const dry = {} as Signals;
  const wet = {} as Signals;
  let branch: AutoCalReport['branch'] = 'measured-both-ends';

  if (hasWet) {
    // The clip spans both conditions — anchor each end on the footage itself.
    dry.glare = p.glare.lo;
    dry.darkness = p.darkness.lo;
    dry.specular = p.specular.lo;
    dry.texture = p.texture.hi;
    wet.glare = p.glare.hi;
    wet.darkness = p.darkness.hi;
    wet.specular = p.specular.hi;
    wet.texture = p.texture.lo;
  } else {
    // Single-condition clip. The far end comes from physics — but the near end
    // is anchored on the *envelope* of what was observed, not its median.
    //
    // Anchoring on the median leaves half the clip above the dry anchor, and on
    // sunlit footage that half is the glinting half: measured on the dry Assen
    // lap the specular fraction reached 24% against a much lower median, so
    // those frames saturated the glare signal and the readout called a dry
    // track "Wet". Anchoring at the top of the observed range means everything
    // the clip actually showed reads as dry — which is the conclusion that was
    // just reached — and only conditions genuinely beyond it climb.
    // Anchored on the observed *extreme*, not the 90th percentile.
    //
    // Specular glare on real footage is violently bimodal: on the dry Assen lap
    // more than 90% of frames register no specular pixels at all inside the
    // ROI, while the handful that catch low sun reach 24%. A p90 anchor
    // therefore sits at zero, every glinting frame lands far past the wet end
    // of the scale, and a dry lap gets reported as Wet — which is exactly what
    // happened. Having concluded the clip is dry, the honest anchor is "the
    // wettest thing in it is still dry".
    if (soaked) {
      branch = 'wet-anchored';
      wet.glare = p.glare.min;
      wet.darkness = p.darkness.min;
      wet.specular = p.specular.min;
      wet.texture = p.texture.max;
      dry.glare = Math.max(0, wet.glare - WET_OFFSET.glareAdd);
      dry.darkness = wet.darkness - WET_OFFSET.darknessAdd;
      dry.specular = Math.max(0, wet.specular - WET_OFFSET.specularAdd);
      dry.texture = wet.texture / WET_OFFSET.textureRatio;
    } else {
      branch = 'dry-anchored';
      dry.glare = p.glare.max;
      dry.darkness = p.darkness.max;
      dry.specular = p.specular.max;
      dry.texture = p.texture.min;
      wet.glare = dry.glare + WET_OFFSET.glareAdd;
      wet.darkness = dry.darkness + WET_OFFSET.darknessAdd;
      wet.specular = dry.specular + WET_OFFSET.specularAdd;
      wet.texture = dry.texture * WET_OFFSET.textureRatio;
    }
  }

  const weak: (keyof Signals)[] = hasWet
    ? KEYS.filter((k) => Math.abs(wet[k] - dry[k]) < 1e-6)
    : [];

  const pct = (wetShare * 100).toFixed(0);
  const note = soaked
    ? `Track is wet throughout — ${pct}% of sampled frames are specular, dark and smooth ` +
      `together, with no dry running in the clip. Wet end anchored on the footage, dry end ` +
      `derived from physics.`
    : hasWet
    ? `Clip contains both dry and wet track — ${pct}% of sampled frames are specular, dark and ` +
      `smooth together. Anchored on ${samples.length} frames from the footage itself.`
    : ambiguous
      ? `Wet track not proven: only ${pct}% of frames met all three water conditions at once, ` +
        `which shadow, sun glint and motion blur can produce on dry tarmac. Treated as dry and ` +
        `anchored conservatively — if this clip really does contain rain, sample the wet anchor ` +
        `by hand on a wet frame.`
      : `No wet track found in this clip — it reads dry throughout. Dry anchored on the footage, ` +
        `wet end derived from physics. The index will sit low, which is the correct answer for dry footage.`;

  return { dry, wet, samples: samples.length, confident: hasWet, weak, spread, branch, note };
}

/** Exported for testing — lets the anchoring logic be exercised without a clip. */
export const __testAnchorsFrom = anchorsFrom;

/**
 * Minimum samples before anchors mean anything at all.
 *
 * Four frames spread over a second. Below that a single passing shadow is the
 * entire dataset and the anchors it produces are noise.
 */
const PROVISIONAL_MIN = 4;

/** Samples at which the anchors stop moving materially. */
const SETTLED_AT = 60;

/** Cadence between republished anchor sets while still converging (~2 s). */
const PUBLISH_EVERY = 8;

/**
 * Cadence after settling (~8 s). The anchors are already good; an index that
 * twitches every two seconds invites doubt without adding information.
 */
const SETTLED_REPUBLISH = 32;

/** Surface samples required before tracer thresholds are trusted and applied. */
const TRACER_MIN = 12;

/** Poll interval — what the live pipeline is already producing, sampled. */
const SAMPLE_MS = 250;

export type LiveCalStage = 'warming' | 'provisional' | 'settling' | 'settled';

export interface LiveCalUpdate {
  stage: LiveCalStage;
  report: AutoCalReport;
  samples: number;
  /** 0..1 — how close the watch is to settled. */
  progress: number;
  note: string;
}

/**
 * Real-time calibration for any feed — clip or live.
 *
 * This replaces both earlier paths. The clip path paused playback and
 * seek-scanned forty sampled frames, costing a frozen readout on every upload;
 * the live path watched a fixed twenty-second window and then stopped. Both
 * are now the same thing: the footage simply plays, this samples what the
 * pipeline already produces, usable anchors are published as soon as they are
 * worth anything, and refinement continues for as long as the feed runs.
 *
 * A reading from second two is genuinely less certain than one from second
 * twenty, and the stage says which it is rather than presenting both with the
 * same confidence — that distinction is the honest part, and it is what makes
 * publishing early defensible instead of just faster.
 *
 * Nothing here blocks the engine, seeks, or pauses anything: probe() reads the
 * current frame without touching session history or smoothing.
 *
 * Runs until aborted (a new source replaced this one, or the check moved on).
 */
export async function autoCalibratePlayback(
  engine: CvEngine,
  onUpdate: (u: LiveCalUpdate) => void,
  opts: { signal?: { aborted: boolean } } = {},
): Promise<AutoCalReport | null> {
  const signals: Signals[] = [];
  const surface: SurfaceSample[] = [];

  let published: AutoCalReport | null = null;
  let lastPublishAt = 0;

  for (;;) {
    if (opts.signal?.aborted) break;

    const m = engine.probe();
    if (m && m.road.pixels > 0) {
      signals.push(toSignals(m.road));
      surface.push({ sat: m.road.sat, luma: m.road.luma });
    }

    const n = signals.length;
    const progress = Math.min(1, n / SETTLED_AT);

    // Republish on a schedule rather than every sample: recomputing anchors
    // four times a second is wasted work, and an index that shifts under the
    // reader every 250 ms is unreadable even when each shift is correct.
    const cadence = n >= SETTLED_AT ? SETTLED_REPUBLISH : PUBLISH_EVERY;
    const due = n >= PROVISIONAL_MIN && (published === null || n - lastPublishAt >= cadence);

    if (due) {
      // Thresholds join the bundle once there are enough surface readings to
      // trust. Applying them changes what the tracer admits, so later samples
      // are measured against a slightly wider corridor — but the clamps bound
      // the drift and the measurement converges as the distribution settles.
      const tracer = surface.length >= TRACER_MIN ? tracerFrom(surface) : undefined;
      published = { ...anchorsFrom(signals), ...(tracer ? { tracer } : {}) };
      lastPublishAt = n;

      const stage: LiveCalStage =
        n >= SETTLED_AT ? 'settled' : n >= PROVISIONAL_MIN * 3 ? 'settling' : 'provisional';

      onUpdate({
        stage,
        report: published,
        samples: n,
        progress,
        note:
          stage === 'settled'
            ? published.note
            : stage === 'settling'
              ? `Anchors settling — ${n} frames watched, still refining. Readings are usable; ` +
                `treat a borderline call as borderline.`
              : `Provisional anchors from ${n} frames. The readout is live, but the scale is ` +
                `still being established — expect the index to shift as the watch continues.`,
      });
    } else if (n < PROVISIONAL_MIN && (!published || lastPublishAt === 0)) {
      onUpdate({
        stage: 'warming',
        report: published ?? ({} as AutoCalReport),
        samples: n,
        progress,
        note:
          n === 0
            ? 'Warming up — waiting for the first frames of road.'
            : `Warming up — ${n} road frame${n === 1 ? '' : 's'} so far.`,
      });
    }

    await new Promise((r) => setTimeout(r, SAMPLE_MS));
  }

  return published;
}

export function applyReport(cal: Calibration, report: AutoCalReport): Calibration {
  return { ...cal, dry: { ...report.dry }, wet: { ...report.wet } };
}
