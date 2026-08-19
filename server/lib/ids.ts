import { randomUUID } from 'node:crypto';

/**
 * Prefixed, sortable-ish identifiers. The prefix means an id in a log line or
 * an error report says what it points at without a lookup.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 22)}`;
}

export const newSessionId = () => newId('ses');
export const newRequestId = () => newId('req');
