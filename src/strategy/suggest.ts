import type { Reading } from '../types';

export type Urgency = 'hold' | 'watch' | 'prepare' | 'act';

export interface Suggestion {
  tyre: string;
  call: string;
  detail: string;
  urgency: Urgency;
}

const RISING = 2.5;   // index units per minute
const FALLING = -2.5;

/**
 * Rule-based pit-wall call. Deliberately not a model: a strategist needs the
 * reasoning to be inspectable and identical every time the same numbers come
 * up, and there is nothing here a model would do better.
 *
 * The ordering matters — the crossover cases are checked before the plain
 * steady-state ones, because a forming dry line is the call that actually wins
 * or loses track position.
 */
export function suggest(r: Reading | null): Suggestion {
  if (!r) {
    return {
      tyre: '—',
      call: 'Awaiting feed',
      detail: 'No frames analysed yet. Load footage or start the synthetic scene.',
      urgency: 'hold',
    };
  }

  const { condition, trend, divergence, wetness } = r;
  const rising = trend > RISING;
  const falling = trend < FALLING;

  if (condition === 'Drying') {
    const strong = divergence > 16;
    return {
      tyre: strong ? 'Slicks' : 'Intermediate',
      call: strong ? 'Box now — crossover' : 'Crossover approaching',
      detail: strong
        ? `Racing line ${divergence.toFixed(0)} points drier than the edges. The dry line will carry slicks; stay off the kerbs on out-lap.`
        : `Line drying ahead of the edges (Δ ${divergence.toFixed(0)}). Hold inters, expect the crossover within 1–2 laps.`,
      urgency: strong ? 'act' : 'prepare',
    };
  }

  if (condition === 'Flooded') {
    return {
      tyre: 'Full wet',
      call: rising ? 'Box now — standing water' : 'Full wets — aquaplaning risk',
      detail:
        `Index ${wetness.toFixed(0)}. Depth is the governing risk now, not grip — full wets clear ` +
        `the most water. If it keeps building this is safety-car territory.`,
      urgency: 'act',
    };
  }

  if (condition === 'Greasy') {
    if (rising) {
      return {
        tyre: 'Slick (marginal)',
        call: 'Ready inters',
        detail:
          `Surface greasy and getting worse (+${trend.toFixed(1)}/min). Slicks are still quicker, ` +
          `but have inters on the wall — the crossover is close.`,
        urgency: 'prepare',
      };
    }
    return {
      tyre: 'Slick',
      call: 'Slicks — stay out',
      detail:
        `Light moisture, no standing water. Slicks remain the quicker tyre here; inters would ` +
        `cost around 5–6 s/lap. Warn the driver on entry.`,
      urgency: 'watch',
    };
  }

  if (condition === 'Wet') {
    if (falling) {
      return {
        tyre: 'Full wet',
        call: 'Hold — watch for a line',
        detail: `Surface easing (${trend.toFixed(1)}/min). Stay on wets and watch the racing-line divergence for the first sign of a dry strip.`,
        urgency: 'watch',
      };
    }
    return {
      tyre: 'Full wet',
      call: rising ? 'Box now — wets' : 'Full wets, hold',
      detail: rising
        ? `Standing water building fast (+${trend.toFixed(1)}/min). Anything but full wets is aquaplaning risk.`
        : `Index ${wetness.toFixed(0)}. Conditions stable and heavy — full wets are the only viable compound.`,
      urgency: rising ? 'act' : 'hold',
    };
  }

  if (condition === 'Damp') {
    if (rising) {
      return {
        tyre: 'Intermediate',
        call: 'Box this lap — inters',
        detail: `Wetness climbing +${trend.toFixed(1)}/min through the damp band. Pit before it crosses into full-wet territory.`,
        urgency: 'act',
      };
    }
    if (falling) {
      return {
        tyre: 'Intermediate',
        call: 'Prepare slicks',
        detail: `Track drying (${trend.toFixed(1)}/min). Have slicks ready in the box; watch the line-versus-edge gap for the trigger.`,
        urgency: 'prepare',
      };
    }
    return {
      tyre: 'Intermediate',
      call: 'Inters, hold',
      detail: `Damp and steady at index ${wetness.toFixed(0)}. Inters are the right compound; no advantage in moving.`,
      urgency: 'hold',
    };
  }

  // Sunny / Dry
  if (condition === 'Sunny' && !rising) {
    return {
      tyre: 'Slicks',
      call: 'Slicks — track baking',
      detail:
        `Dry and sunlit at index ${wetness.toFixed(0)}. Surface is burning off any residual ` +
        `moisture; watch tyre surface temperature rather than the weather.`,
      urgency: 'hold',
    };
  }
  if (rising) {
    return {
      tyre: 'Slicks',
      call: 'Watch — moisture building',
      detail: `Still dry but the index is climbing +${trend.toFixed(1)}/min. Ready inters; call the driver if it reaches the damp band.`,
      urgency: 'watch',
    };
  }
  return {
    tyre: 'Slicks',
    call: 'Slicks — no action',
    detail: `Surface dry and stable at index ${wetness.toFixed(0)}. Track is holding; no tyre action required.`,
    urgency: 'hold',
  };
}
