import { describe, it, expect } from 'vitest';
import { sleepWithJitter, parseRetryAfter } from '../src/utils/backoff.js';

describe('backoff', () => {
  it('parseRetryAfter parses seconds', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('0')).toBe(0);
  });
  it('parseRetryAfter parses HTTP-date approximately', () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfter(future) ?? 0;
    expect(ms).toBeGreaterThan(8_000);
    expect(ms).toBeLessThan(12_000);
  });
  it('parseRetryAfter returns undefined for nonsense', () => {
    expect(parseRetryAfter('not-a-date')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
  it('sleepWithJitter respects retry-after when given', async () => {
    const start = Date.now();
    await sleepWithJitter(0, 80);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(200);
  });
});
