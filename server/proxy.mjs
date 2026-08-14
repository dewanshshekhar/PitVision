import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const PORT = Number(process.env.PORT ?? 8787);
const MODEL = process.env.PITVISION_MODEL ?? 'claude-opus-5';

const app = express();
app.use(express.json({ limit: '12mb' }));

// The API key lives here and only here. The browser never sees it — this is
// the whole reason verification goes through a proxy rather than fetch().
const configured = Boolean(process.env.ANTHROPIC_API_KEY);
const client = configured ? new Anthropic() : null;

const SCHEMA = {
  type: 'object',
  properties: {
    condition: {
      type: 'string',
      enum: ['Dry', 'Damp', 'Wet', 'Drying', 'Unknown'],
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
- Dry: matte surface, visible aggregate texture, no reflections, no spray.
- Damp: surface darkened by moisture, patchy sheen, little or no standing water.
- Wet: strong mirror-like reflections, standing water, visible spray off tyres.
- Drying: the racing line is visibly lighter and drier than the track edges — a dry line is forming.

Judge the frame on its own evidence. You are told what the CV engine concluded, but that is
context, not an answer to agree with: say what you actually see. If the frame is too dark,
blurred, or does not show a track surface, answer Unknown with low confidence.`;

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, configured, model: MODEL });
});

app.post('/api/verify', async (req, res) => {
  if (!client) {
    return res.status(503).json({
      error: 'ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add a key.',
    });
  }

  const { image, cv } = req.body ?? {};
  if (typeof image !== 'string' || !image.startsWith('data:image/')) {
    return res.status(400).json({ error: 'Expected `image` as a data: URL.' });
  }

  const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s.exec(image);
  if (!match) {
    return res.status(400).json({ error: 'Unsupported image encoding.' });
  }
  const [, mediaType, base64] = match;

  const context = cv
    ? `The CV engine currently reads: ${cv.condition} (wetness index ${cv.wetness}/100). ` +
      `Racing line ${cv.racingLine}, track edges ${cv.trackEdges}, divergence ${cv.divergence}. ` +
      `Trend ${cv.trendPerMin > 0 ? '+' : ''}${cv.trendPerMin} index points per minute.`
    : 'No CV context supplied.';

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      // Verification runs on a timer next to a live UI, so it is tuned for
      // latency: no thinking, low effort, and a schema-constrained answer that
      // needs no parsing heuristics on the client.
      thinking: { type: 'disabled' },
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: SCHEMA },
      },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            {
              type: 'text',
              text: `${context}\n\nGive your own independent read of this frame.`,
            },
          ],
        },
      ],
    });

    if (message.stop_reason === 'refusal') {
      return res.status(422).json({
        error: 'Model declined this frame.',
        category: message.stop_details?.category ?? null,
      });
    }

    const text = message.content.find((b) => b.type === 'text')?.text;
    if (!text) {
      return res.status(502).json({ error: 'Empty response from model.' });
    }

    const parsed = JSON.parse(text);
    res.json({ ...parsed, model: message.model, usage: message.usage });
  } catch (err) {
    const status = err?.status && Number.isInteger(err.status) ? err.status : 502;
    console.error('[verify]', err?.message ?? err);
    res.status(status).json({ error: err?.message ?? 'Verification failed.' });
  }
});

// Serve the production build when one exists, so `npm run build && npm start`
// is a single process on a single port.
const dist = join(root, 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`PitVision verification proxy → http://localhost:${PORT}`);
  console.log(`  model: ${MODEL}`);
  console.log(`  ANTHROPIC_API_KEY: ${configured ? 'set' : 'NOT SET — verification will return 503'}`);
  if (existsSync(dist)) console.log('  serving production build from dist/');
});
