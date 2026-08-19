import type { Request } from 'express';

/**
 * The key a rate limit is counted against.
 *
 * `x-forwarded-for` is trusted only when the deployment says there is a proxy
 * in front, because the header is client-supplied: honouring it unconditionally
 * means anyone can reset their own bucket by inventing an address. An explicit
 * client id is preferred where the client sends one, since several engineers
 * behind one garage NAT should not share a budget.
 */
export function clientKey(req: Request, trustProxy: boolean): string {
  const declared = req.get('x-pitvision-client');
  if (declared) return `client:${declared.slice(0, 80)}`;

  if (trustProxy) {
    const fwd = req.get('x-forwarded-for');
    if (fwd) return `ip:${fwd.split(',')[0].trim()}`;
  }
  return `ip:${req.socket.remoteAddress ?? 'unknown'}`;
}
