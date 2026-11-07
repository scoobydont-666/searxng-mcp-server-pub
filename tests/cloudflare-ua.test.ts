import { describe, it, expect, vi, afterEach } from 'vitest';
import { safeFetch as rawSafeFetch } from '../src/utils/fetch-client.js';
import { asFetchRequest } from './fixtures.js';
const safeFetch = (url: string, opts?: Parameters<typeof rawSafeFetch>[1]) => asFetchRequest(() => rawSafeFetch(url, opts));
import { config } from '../src/constants.js';

afterEach(() => vi.restoreAllMocks());

describe('transparent fetch identity', () => {
  it.each([403, 429, 503])('returns a blocking HTTP %s without retrying or changing identity', async status => {
    const seen: string[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      seen.push(new Headers(init?.headers).get('User-Agent') ?? '');
      return new Response('blocked', { status, headers: { server: 'cloudflare', 'cf-ray': 'fixture' } });
    });
    const result = await safeFetch('https://example.test/path');
    result.release();
    expect(result.status).toBe(status);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([config.userAgent]);
  });

  it('rejects a caller User-Agent override and cannot be overridden through headers', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    await expect(safeFetch('https://example.test/path', { user_agent: 'Browser-Impersonation/1' })).rejects.toThrow(/server configuration/);
    expect(spy).not.toHaveBeenCalled();
    (await safeFetch('https://example.test/path', { headers: { 'user-agent': 'different' } })).release();
    expect(new Headers(spy.mock.calls[0][1]?.headers).get('User-Agent')).toBe(config.userAgent);
  });
});
