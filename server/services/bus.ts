/**
 * Live fan-out.
 *
 * The detector runs in one browser tab. A pit wall is several people looking at
 * several screens, and the engineer who needs to see "dry line forming" is not
 * necessarily the one holding the laptop the footage is loaded on. The bus lets
 * any number of read-only clients subscribe to a session — or to everything, for
 * an operations view — over Server-Sent Events.
 *
 * SSE rather than WebSocket because the traffic is one-directional, it survives
 * proxies that mangle upgrades, and the browser reconnects on its own.
 */

import type { Response } from 'express';
import type { Logger } from '../lib/log.ts';

export type BusTopic = string;

export interface BusMessage {
  type: string;
  sessionId?: string;
  data: unknown;
}

interface Subscriber {
  id: number;
  res: Response;
  /** Session id, or '*' for every session. */
  topic: BusTopic;
  since: number;
}

const HEARTBEAT_MS = 15_000;

export class Bus {
  private subs = new Map<number, Subscriber>();
  private nextId = 1;
  private heartbeat: NodeJS.Timeout;
  private closed = false;

  private readonly log: Logger;

  constructor(log: Logger) {
    this.log = log;
    this.heartbeat = setInterval(() => this.ping(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  get subscriberCount() {
    return this.subs.size;
  }

  /** Attach a response as an SSE stream. Returns a detach function. */
  subscribe(res: Response, topic: BusTopic): () => void {
    const id = this.nextId++;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx buffers event streams by default and the symptom is a live feed
      // that arrives in one lump minutes later.
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);

    const sub: Subscriber = { id, res, topic, since: Date.now() };
    this.subs.set(id, sub);
    this.log.debug('sse subscribed', { id, topic, total: this.subs.size });

    const detach = () => {
      if (this.subs.delete(id)) {
        this.log.debug('sse detached', { id, topic, total: this.subs.size });
      }
    };
    res.on('close', detach);
    res.on('error', detach);
    return detach;
  }

  publish(msg: BusMessage) {
    if (this.closed || this.subs.size === 0) return;
    const frame = `event: ${msg.type}\ndata: ${JSON.stringify({
      type: msg.type,
      sessionId: msg.sessionId ?? null,
      at: Date.now(),
      data: msg.data,
    })}\n\n`;

    for (const sub of this.subs.values()) {
      if (sub.topic !== '*' && sub.topic !== msg.sessionId) continue;
      this.write(sub, frame);
    }
  }

  private write(sub: Subscriber, frame: string) {
    try {
      // A subscriber whose socket has stopped draining is a slow consumer, and
      // buffering for it would grow the server's heap until something gives.
      // Dropping it is correct: SSE clients reconnect, and a live readout that
      // is minutes behind is worse than one that visibly reconnected.
      if (sub.res.writableLength > 1_000_000) {
        this.log.warn('sse subscriber too slow, dropping', { id: sub.id, topic: sub.topic });
        this.subs.delete(sub.id);
        sub.res.end();
        return;
      }
      sub.res.write(frame);
    } catch (err) {
      this.log.debug('sse write failed', { id: sub.id, err });
      this.subs.delete(sub.id);
    }
  }

  private ping() {
    const frame = `: ping ${Date.now()}\n\n`;
    for (const sub of this.subs.values()) this.write(sub, frame);
  }

  close() {
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const sub of this.subs.values()) {
      try {
        sub.res.write('event: shutdown\ndata: {}\n\n');
        sub.res.end();
      } catch {
        /* already gone */
      }
    }
    this.subs.clear();
  }
}
