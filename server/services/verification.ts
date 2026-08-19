/**
 * AI verification, as an audited service.
 *
 * The call itself is unchanged in spirit — one frame, one schema-constrained
 * answer, off the critical path. What is new is that every attempt is recorded:
 * the verdict, the grade against the CV call, the latency, the tokens and what
 * they cost, and the failures. Without that record the product's central claim
 * — that the AI checks the detector and disagreement is surfaced — was only
 * true for the ten seconds one card stayed on screen.
 */

import Anthropic from '@anthropic-ai/sdk';

import type { Config } from '../config.ts';
import type { Logger } from '../lib/log.ts';
import type { Store } from './store.ts';
import type { Metrics } from './metrics.ts';
import type { Bus } from './bus.ts';
import type { Monitor } from './monitor.ts';
import { CONDITIONS, grade, isCondition, type AgreementLevel, type Condition } from '../domain/conditions.ts';
import { unavailable, badRequest } from '../lib/http.ts';

/**
 * The model's answer space.
 *
 * This used to be `Dry | Damp | Wet | Drying | Unknown` while the engine
 * classified into seven states. Any frame the engine called `Sunny`, `Greasy`
 * or `Flooded` was therefore recorded as a disagreement by construction — the
 * model had no way to spell the word it was being compared against. Agreement
 * statistics computed over that were meaningless, and the "flags for review"
 * chip fired on frames where both sides had in fact seen the same thing.
 */
const SCHEMA = {
  type: 'object',
  properties: {
    condition: {
      type: 'string',
      enum: [...CONDITIONS, 'Unknown'],
      description: 'Your own independent read of the track surface in the image.',
    },
    confidence: {
      type: 'number',
      description: 'How confident you are in that call, from 0 to 1.',
    },
    reasoning: {
      type: 'string',
      description:
        'One or two sentences citing the specific visual evidence you used — reflections, ' +
        'spray, surface colour, a visible dry line. Written for a race engineer, no hedging.',
    },
  },
  required: ['condition', 'confidence', 'reasoning'],
  additionalProperties: false,
};

const SYSTEM = `You are a second opinion for a motorsport pit wall.

A computer-vision engine analyses a trackside camera feed and calls the surface condition
continuously. Your job is to look at one frame and give your own independent read, so the
strategist knows whether the automated call is trustworthy right now.

Definitions, in the sense a race engineer uses them:
- Sunny: dry and directly sunlit — bright matte tarmac, hard shadows, any moisture baking off.
- Dry: matte surface, visible aggregate texture, no reflections, no spray.
- Greasy: no standing water, but the surface has lost its matte bite — dusty, damp-edged or
  freshly rained on and mostly gone.
- Damp: surface darkened by moisture, patchy sheen, little or no standing water.
- Wet: strong mirror-like reflections, standing water, visible spray off tyres.
- Flooded: standing water deep enough that aquaplaning, not grip, is the governing risk —
  rivers across the track, heavy spray, visible depth.
- Drying: the racing line is visibly lighter and drier than the track edges — a dry line is forming.

Judge the frame on its own evidence. You are told what the CV engine concluded, but that is
context, not an answer to agree with: say what you actually see. If the frame is too dark,
blurred, or does not show a track surface, answer Unknown with low confidence.`;

export interface VerifyRequest {
  image: string;
  sessionId?: string | null;
  cv?: {
    condition?: string;
    wetness?: number;
    racingLine?: number;
    trackEdges?: number;
    divergence?: number;
    trendPerMin?: number;
  } | null;
}

export interface VerifyResult {
  id: number;
  condition: Condition | 'Unknown';
  confidence: number;
  reasoning: string;
  agreement: AgreementLevel | null;
  agrees: boolean;
  model: string;
  latencyMs: number;
  usage: { input_tokens: number; output_tokens: number } | null;
  costUsd: number | null;
}

export class VerificationService {
  private readonly client: Anthropic | null;
  private readonly store: Store;
  private readonly metrics: Metrics;
  private readonly bus: Bus;
  private readonly monitor: Monitor;
  private readonly config: Config;
  private readonly log: Logger;

  constructor(
    store: Store,
    metrics: Metrics,
    bus: Bus,
    monitor: Monitor,
    config: Config,
    log: Logger,
  ) {
    this.store = store;
    this.metrics = metrics;
    this.bus = bus;
    this.monitor = monitor;
    this.config = config;
    this.log = log;
    this.client = config.anthropicKey
      ? new Anthropic({ apiKey: config.anthropicKey, maxRetries: 0, timeout: config.verifyTimeoutMs })
      : null;
  }

  get configured() {
    return this.client !== null;
  }

  async verify(req: VerifyRequest): Promise<VerifyResult> {
    if (!this.client) {
      throw unavailable('ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add a key.');
    }

    const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s.exec(req.image ?? '');
    if (!match) {
      throw badRequest('Expected `image` as a data: URL with jpeg, png or webp content.');
    }
    const mediaType = match[1] as 'image/jpeg' | 'image/png' | 'image/webp';
    const base64 = match[2];
    const imageBytes = Math.floor((base64.length * 3) / 4);

    const cvCondition = isCondition(req.cv?.condition) ? (req.cv.condition as Condition) : null;
    const started = Date.now();
    const t0 = performance.now();

    let attempts = 0;
    let lastErr: unknown = null;

    // Retries are for transport faults only. A 400 means the request is wrong
    // and sending it again just spends money to be told so a second time.
    while (attempts <= this.config.verifyRetries) {
      attempts++;
      try {
        const message = await this.client.messages.create(
          {
            model: this.config.model,
            max_tokens: 1024,
            system: SYSTEM,
            // Verification runs on a timer next to a live UI, so it is tuned for
            // latency: low effort, and a schema-constrained answer that needs no
            // parsing heuristics on the client.
            //
            // Effort is the latency lever here, not `thinking: {type:'disabled'}`.
            // Turning thinking off on this model tier is known to leak internal
            // `<thinking>` tags into the visible response — and the visible
            // response here is the sentence a race engineer reads off the
            // verification card. Adaptive thinking at low effort costs about the
            // same and cannot produce that.
            thinking: { type: 'adaptive' },
            output_config: {
              effort: 'low',
              format: { type: 'json_schema', schema: SCHEMA },
            },
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
                  { type: 'text', text: `${describeCv(req.cv)}\n\nGive your own independent read of this frame.` },
                ],
              },
            ],
          },
          { timeout: this.config.verifyTimeoutMs },
        );

        const latencyMs = Math.round(performance.now() - t0);
        this.metrics.observeVerify(latencyMs);

        if (message.stop_reason === 'refusal') {
          const id = this.record({
            req,
            cvCondition,
            status: 'refused',
            started,
            latencyMs,
            attempts,
            imageBytes,
            error: `refused: ${message.stop_details?.category ?? 'unspecified'}`,
          });
          this.metrics.inc('pitvision_verifications_total', 1, { status: 'refused' });
          throw Object.assign(new Error('Model declined this frame.'), { status: 422, verificationId: id });
        }

        const text = message.content.find((b) => b.type === 'text')?.text;
        if (!text) throw new Error('Empty response from model.');

        const parsed = JSON.parse(text) as {
          condition: Condition | 'Unknown';
          confidence: number;
          reasoning: string;
        };

        const agreement = cvCondition ? grade(cvCondition, parsed.condition) : null;
        const input = message.usage?.input_tokens ?? 0;
        const output = message.usage?.output_tokens ?? 0;
        const costUsd = this.cost(input, output);

        const id = this.record({
          req,
          cvCondition,
          status: 'ok',
          started,
          latencyMs,
          attempts,
          imageBytes,
          aiCondition: parsed.condition,
          confidence: parsed.confidence,
          reasoning: parsed.reasoning,
          agreement,
          model: message.model,
          inputTokens: input,
          outputTokens: output,
          costUsd,
        });

        this.metrics.inc('pitvision_verifications_total', 1, { status: 'ok' });
        if (agreement) this.metrics.inc('pitvision_verification_agreement_total', 1, { level: agreement });
        this.metrics.inc('pitvision_verification_input_tokens_total', input);
        this.metrics.inc('pitvision_verification_output_tokens_total', output);
        this.metrics.inc('pitvision_verification_cost_usd_total', costUsd);

        const result: VerifyResult = {
          id,
          condition: parsed.condition,
          confidence: parsed.confidence,
          reasoning: parsed.reasoning,
          agreement,
          // Kept for the existing client, which reads a boolean. `adjacent`
          // counts as agreement here: two people looking at the same tarmac
          // splitting Damp from Wet is not a fault worth flagging on screen.
          agrees: agreement === 'match' || agreement === 'adjacent',
          model: message.model,
          latencyMs,
          usage: { input_tokens: input, output_tokens: output },
          costUsd,
        };

        if (req.sessionId) {
          this.bus.publish({ type: 'verification', sessionId: req.sessionId, data: result });
          this.monitor.observeVerification(req.sessionId);
        }

        this.log.info('verification complete', {
          sessionId: req.sessionId ?? null,
          cv: cvCondition,
          ai: parsed.condition,
          agreement,
          latencyMs,
          costUsd,
        });

        return result;
      } catch (err) {
        lastErr = err;
        const status = (err as { status?: number }).status;
        const retryable = status === undefined || status === 408 || status === 429 || status >= 500;
        if (!retryable || attempts > this.config.verifyRetries) break;
        this.log.warn('verification attempt failed, retrying', { attempt: attempts, err });
        await sleep(Math.min(2000, 250 * 2 ** (attempts - 1)));
      }
    }

    const latencyMs = Math.round(performance.now() - t0);
    const isTimeout = /timeout|aborted/i.test(String((lastErr as Error)?.message ?? ''));
    const id = this.record({
      req,
      cvCondition,
      status: isTimeout ? 'timeout' : 'error',
      started,
      latencyMs,
      attempts,
      imageBytes,
      error: String((lastErr as Error)?.message ?? lastErr),
    });

    this.metrics.inc('pitvision_verifications_total', 1, { status: isTimeout ? 'timeout' : 'error' });
    if (req.sessionId) this.monitor.observeVerification(req.sessionId);
    this.log.error('verification failed', { sessionId: req.sessionId ?? null, attempts, err: lastErr });

    const status = (lastErr as { status?: number })?.status;
    throw Object.assign(new Error(String((lastErr as Error)?.message ?? 'Verification failed.')), {
      status: Number.isInteger(status) ? status : 502,
      verificationId: id,
    });
  }

  private cost(input: number, output: number): number {
    const { inputPerMTok, outputPerMTok } = this.config.pricing;
    return (input / 1e6) * inputPerMTok + (output / 1e6) * outputPerMTok;
  }

  private record(args: {
    req: VerifyRequest;
    cvCondition: Condition | null;
    status: 'ok' | 'refused' | 'error' | 'timeout';
    started: number;
    latencyMs: number;
    attempts: number;
    imageBytes: number;
    aiCondition?: string;
    confidence?: number;
    reasoning?: string;
    agreement?: AgreementLevel | null;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    error?: string;
  }): number {
    const cv = args.req.cv;
    // A session id from a client that has since been pruned would violate the
    // foreign key and lose the record entirely, so an orphan is stored with a
    // null session rather than dropped — a failed verification is exactly the
    // row you want to still have afterwards.
    const sessionId =
      args.req.sessionId && this.store.getSession(args.req.sessionId) ? args.req.sessionId : null;

    return this.store.insertVerification({
      sessionId,
      t: args.started,
      status: args.status,
      cvCondition: args.cvCondition,
      cvWetness: numOrNull(cv?.wetness),
      cvLine: numOrNull(cv?.racingLine),
      cvEdge: numOrNull(cv?.trackEdges),
      cvTrend: numOrNull(cv?.trendPerMin),
      aiCondition: args.aiCondition ?? null,
      confidence: numOrNull(args.confidence),
      reasoning: args.reasoning ?? null,
      agreement: args.agreement ?? null,
      model: args.model ?? this.config.model,
      latencyMs: args.latencyMs,
      inputTokens: args.inputTokens ?? null,
      outputTokens: args.outputTokens ?? null,
      costUsd: args.costUsd ?? null,
      imageBytes: args.imageBytes,
      attempts: args.attempts,
      error: args.error ?? null,
    });
  }
}

function describeCv(cv: VerifyRequest['cv']): string {
  if (!cv) return 'No CV context supplied.';
  const trend = numOrNull(cv.trendPerMin);
  return (
    `The CV engine currently reads: ${cv.condition} (wetness index ${cv.wetness}/100). ` +
    `Racing line ${cv.racingLine}, track edges ${cv.trackEdges}, divergence ${cv.divergence}. ` +
    `Trend ${trend !== null && trend > 0 ? '+' : ''}${trend ?? '?'} index points per minute.`
  );
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
