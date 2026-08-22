import type { Config } from '../config.ts';
import type { Logger } from '../lib/log.ts';

export interface PitWallTrackData {
  wetness: number;
  trend: number;
  condition: string;
  divergence: number;
  glare?: number;
  texture?: number;
}

export interface PitWallTyreData {
  compound: string;
  ageLaps: number;
  lifePct: number;
  tempFl: number;
  tempFr: number;
  tempRl: number;
  tempRr: number;
  currentLap: number;
  totalLaps: number;
}

export interface PitWallRequest {
  track: PitWallTrackData;
  tyre?: Partial<PitWallTyreData>;
  sessionId?: string | null;
}

export interface PitWallResponse {
  urgency: 'HOLD' | 'WATCH' | 'PREPARE' | 'ACT' | 'BOX NOW';
  recommendedTyre: string;
  call: string;
  feedback: string;
  model: string;
  latencyMs: number;
}

const DEFAULT_TYRE: PitWallTyreData = {
  compound: 'Soft (C4)',
  ageLaps: 12,
  lifePct: 76,
  tempFl: 98,
  tempFr: 101,
  tempRl: 103,
  tempRr: 105,
  currentLap: 22,
  totalLaps: 53,
};

export class PitWallService {
  private config: Config;
  private log: Logger;

  constructor(config: Config, log: Logger) {
    this.config = config;
    this.log = log;
  }

  get isConfigured(): boolean {
    return Boolean(this.config.groqKey);
  }

  async advise(req: PitWallRequest): Promise<PitWallResponse> {
    const t0 = performance.now();
    const groqKey = this.config.groqKey;
    const model = this.config.groqModel || 'qwen/qwen3.6-27b';

    const track = req.track;
    const tyre = { ...DEFAULT_TYRE, ...(req.tyre || {}) };

    if (!groqKey) {
      return this.ruleBasedFallback(track, tyre, performance.now() - t0);
    }

    const systemPrompt =
      `You are an elite Formula 1 Chief Race Engineer speaking directly to the driver on team radio (like Bono or GP).\n` +
      `Based on the live track computer-vision telemetry and car data, give an authentic, decisive, human radio call.\n` +
      `Keep feedback punchy, natural, and under 20 words. Always end feedback with 'Over.'\n` +
      `Respond ONLY with a JSON object in this schema:\n` +
      `{\n` +
      `  "urgency": "HOLD" | "WATCH" | "PREPARE" | "ACT" | "BOX NOW",\n` +
      `  "recommendedTyre": "Slicks" | "Intermediate" | "Full Wets",\n` +
      `  "call": "short headline under 5 words (e.g. Box now for Inters)",\n` +
      `  "feedback": "human radio message under 20 words ending with Over."\n` +
      `}`;

    const userPrompt =
      `Live Track CV Metrics:\n` +
      `- Wetness Index: ${track.wetness.toFixed(1)} / 100\n` +
      `- Track Condition: ${track.condition}\n` +
      `- Trend Rate: ${track.trend >= 0 ? '+' : ''}${track.trend.toFixed(2)} units/min\n` +
      `- Racing Line vs Edge Divergence: ${track.divergence >= 0 ? '+' : ''}${track.divergence.toFixed(1)}\n` +
      `- Specular Glare: ${(track.glare ?? 0).toFixed(3)}\n` +
      `- Surface Texture: ${(track.texture ?? 0).toFixed(3)}\n\n` +
      `Car & Tyre Telemetry:\n` +
      `- Current Tyre: ${tyre.compound} (${tyre.ageLaps}L old, Lap ${tyre.currentLap}/${tyre.totalLaps})\n` +
      `- Estimated Remaining Grip: ${tyre.lifePct}%\n` +
      `- Tyre Bulk Temps: FL ${tyre.tempFl}°C, FR ${tyre.tempFr}°C, RL ${tyre.tempRl}°C, RR ${tyre.tempRr}°C\n\n` +
      `Give the strategic radio call.`;

    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${groqKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
          max_tokens: 2048,
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        this.log.warn('Groq API returned error status', { status: res.status, err: errText });
        return this.ruleBasedFallback(track, tyre, performance.now() - t0);
      }

      const data = (await res.json()) as any;
      const rawContent = data.choices?.[0]?.message?.content || '';

      // Strip reasoning <think>...</think> if present
      const cleanContent = rawContent.includes('</think>')
        ? rawContent.split('</think>')[1].trim()
        : rawContent.trim();

      const jsonMatch = cleanContent.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.log.warn('Could not parse JSON from Groq Qwen output', { raw: rawContent });
        return this.ruleBasedFallback(track, tyre, performance.now() - t0);
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const latencyMs = Math.round(performance.now() - t0);

      const urgency = (['HOLD', 'WATCH', 'PREPARE', 'ACT', 'BOX NOW'].includes(parsed.urgency)
        ? parsed.urgency
        : 'HOLD') as PitWallResponse['urgency'];

      let feedback = String(parsed.feedback || 'Maintain stint pace. Over.');
      if (!feedback.trim().endsWith('Over.') && !feedback.trim().endsWith('Over')) {
        feedback = feedback.replace(/[.\s]+$/, '') + '. Over.';
      }

      return {
        urgency,
        recommendedTyre: String(parsed.recommendedTyre || 'Slicks'),
        call: String(parsed.call || 'Stay out, maintain pace'),
        feedback,
        model,
        latencyMs,
      };
    } catch (err: any) {
      this.log.error('PitWallService failed calling Groq', { err: err?.message });
      return this.ruleBasedFallback(track, tyre, performance.now() - t0);
    }
  }

  private ruleBasedFallback(
    track: PitWallTrackData,
    tyre: PitWallTyreData,
    elapsedMs: number,
  ): PitWallResponse {
    const { condition, wetness, trend } = track;
    if (condition === 'Flooded' || wetness > 75) {
      return {
        urgency: 'BOX NOW',
        recommendedTyre: 'Full Wets',
        call: 'Box, box for Wets',
        feedback: 'Box, box. Heavy standing water, fit full wets this lap and watch turn 4 kerbs. Over.',
        model: 'pit-engineer',
        latencyMs: Math.round(elapsedMs),
      };
    }
    if (condition === 'Wet' || wetness > 50) {
      return {
        urgency: trend > 2 ? 'BOX NOW' : 'ACT',
        recommendedTyre: 'Full Wets',
        call: trend > 2 ? 'Box this lap' : 'Box for Inters',
        feedback: trend > 2
          ? 'Heavy rain incoming. Box this lap for full wets. Over.'
          : 'Box for Inters this lap. Track is wet, manage braking into turn 1. Over.',
        model: 'pit-engineer',
        latencyMs: Math.round(elapsedMs),
      };
    }
    if (condition === 'Damp' || (wetness > 25 && wetness <= 50)) {
      return {
        urgency: trend > 2 ? 'PREPARE' : 'HOLD',
        recommendedTyre: 'Intermediate',
        call: trend > 2 ? 'Prepare Inters' : 'Stay out on Inters',
        feedback: trend > 2
          ? 'Rain increasing. Stand by for Inters, push on this lap. Over.'
          : 'Stay out. Inters are in the window, find wet lines on straights to cool. Over.',
        model: 'pit-engineer',
        latencyMs: Math.round(elapsedMs),
      };
    }
    if (condition === 'Drying') {
      return {
        urgency: 'PREPARE',
        recommendedTyre: 'Slicks',
        call: 'Crossover approaching',
        feedback: 'Dry line is appearing. Stand by for slick crossover, push on in-lap. Over.',
        model: 'pit-engineer',
        latencyMs: Math.round(elapsedMs),
      };
    }
    // Dry / Sunny
    return {
      urgency: 'HOLD',
      recommendedTyre: 'Slicks',
      call: condition === 'Sunny' ? 'Pace is strong, push' : 'Stay out, tyres healthy',
      feedback: `Track is dry and clear. ${tyre.compound} tyres are in good shape, maintain pace. Over.`,
      model: 'pit-engineer',
      latencyMs: Math.round(elapsedMs),
    };
  }
}
