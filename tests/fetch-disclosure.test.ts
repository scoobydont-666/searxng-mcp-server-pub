import { afterEach, describe, expect, it, vi } from 'vitest';
import { asFetchRequest, fixturePrincipal } from './fixtures.js';
import { principalDigest } from '../src/utils/request-context.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

async function failureOf(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a fetch failure');
}

describe('fetch failures do not disclose destination policy to callers', () => {
  it('returns one generic message for allowlist, literal-address, scheme and DNS denials', async () => {
    const { safeFetch } = await import('../src/utils/fetch-client.js');
    const { config } = await import('../src/constants.js');
    const saved = [...config.allowedDomains];
    config.allowedDomains.splice(0, config.allowedDomains.length, 'resolves-private.example.invalid', 'listed.example.invalid');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const cases = [
        'https://unlisted.example.invalid/',
        'https://10.0.0.1/',
        'https://[fd00::1]/',
        'ftp://listed.example.invalid/',
        'https://localhost/',
      ];
      const messages = [];
      for (const url of cases) {
        const error = await failureOf(() => asFetchRequest(() => safeFetch(url)));
        messages.push(error.message);
      }
      expect(new Set(messages)).toEqual(new Set(['fetch_failed']));
    } finally {
      config.allowedDomains.splice(0, config.allowedDomains.length, ...saved);
    }
  });

  it('keeps the DNS-to-private reason in the server log and out of the caller error', async () => {
    const { safeFetch } = await import('../src/utils/fetch-client.js');
    const { config } = await import('../src/constants.js');
    const saved = [...config.allowedDomains];
    config.allowedDomains.splice(0, config.allowedDomains.length, 'localhost');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const error = await failureOf(() => asFetchRequest(() => safeFetch('https://localhost/private/path?token=secret')));
      expect(error.message).toBe('fetch_failed');
      expect(error.message).not.toMatch(/localhost|127\.0\.0\.1|::1|DNS|address/i);
      const logged = write.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('"reason":"EACCES"');
      expect(logged).not.toContain('/private/path');
      expect(logged).not.toContain('token=secret');
    } finally {
      config.allowedDomains.splice(0, config.allowedDomains.length, ...saved);
    }
  });
});

describe('per-fetch audit log', () => {
  async function freshFetch(level: 'info' | 'debug') {
    vi.stubEnv('SEARXNG_MCP_LOG_LEVEL', level);
    vi.resetModules();
    const { safeFetch } = await import('../src/utils/fetch-client.js');
    return (url: string) => asFetchRequest(() => safeFetch(url));
  }

  it('is debug-level, carries a principal digest and never the principal id or token', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok', { headers: { 'content-type': 'text/plain' } }));
    await (await freshFetch('info'))('https://93.184.216.34/path?q=secret');
    expect(write.mock.calls.map((call) => String(call[0])).join('')).not.toContain('"msg":"fetch"');

    write.mockClear();
    await (await freshFetch('debug'))('https://93.184.216.34/path?q=secret');
    const lines = write.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('"msg":"fetch"'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'debug', host: '93.184.216.34', principal: principalDigest(fixturePrincipal.id) });
    expect(lines[0]).not.toContain(fixturePrincipal.id);
    expect(lines[0]).not.toContain('/path');
    expect(lines[0]).not.toContain('secret');
  });
});
