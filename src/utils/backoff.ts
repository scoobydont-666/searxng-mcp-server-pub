import { setTimeout as delay } from 'node:timers/promises';
import { requestContext } from './request-context.js';
/**
 * Exponential backoff with jitter. Used for both SearXNG calls and outbound URL fetches.
 *
 * Schedule: 500ms, 2s, 8s — each attempt picks ±20% jitter to avoid thundering herd.
 * If a Retry-After hint is provided, that wins over the schedule (capped at 30s).
 */
const SCHEDULE_MS = [500, 2000, 8000];
const MAX_RETRY_AFTER_MS = 30000;

export async function sleepWithJitter(attempt: number, retryAfterMs?: number): Promise<void> {
  if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
    await delay(Math.min(retryAfterMs, MAX_RETRY_AFTER_MS),undefined,{signal:requestContext.getStore()?.signal});
    return;
  }
  const base = SCHEDULE_MS[Math.min(attempt, SCHEDULE_MS.length - 1)] ?? 8000;
  const jitter = base * (Math.random() * 0.4 - 0.2); // ±20%
  await delay(Math.max(0,base+jitter),undefined,{signal:requestContext.getStore()?.signal});
}

/**
 * Parse a `Retry-After` header value (seconds OR HTTP-date) into milliseconds.
 * Returns undefined if unparseable.
 */
export function parseRetryAfter(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number.parseFloat(v);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const t = Date.parse(v);
  if (Number.isFinite(t)) return Math.max(0, t - Date.now());
  return undefined;
}
