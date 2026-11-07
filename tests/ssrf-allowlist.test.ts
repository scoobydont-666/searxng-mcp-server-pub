/**
 * Hostname matcher and redirect tests. The pure matcher alone is not an SSRF
 * boundary: startup requires an explicit allowlist when fetch tools are enabled,
 * and the fetch connection separately rejects private/reserved DNS addresses.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { isDomainAllowed, safeFetch as rawSafeFetch } from '../src/utils/fetch-client.js';
import { resolveRedditJsonUrl } from '../src/tools/reddit.js';
import { config } from '../src/constants.js';
import { asFetchRequest } from './fixtures.js';

const safeFetch = (url: string, opts?: Parameters<typeof rawSafeFetch>[1]) => asFetchRequest(() => rawSafeFetch(url, opts));

describe('isDomainAllowed — SSRF allowlist', () => {
  describe('pure matcher with an empty list', () => {
    it('empty array permits any public host', () => {
      expect(isDomainAllowed('github.com', [])).toBe(true);
      expect(isDomainAllowed('example.com', [])).toBe(true);
      expect(isDomainAllowed('198.51.100.1', [])).toBe(true);
      expect(isDomainAllowed('10.20.30.40', [])).toBe(true);
      expect(isDomainAllowed('localhost', [])).toBe(true);
    });
  });

  describe('exact match', () => {
    it('permits listed domains', () => {
      const list = ['github.com', 'arxiv.org', 'example.com'];
      expect(isDomainAllowed('github.com', list)).toBe(true);
      expect(isDomainAllowed('arxiv.org', list)).toBe(true);
      expect(isDomainAllowed('example.com', list)).toBe(true);
    });

    it('rejects unlisted domains', () => {
      const list = ['github.com', 'arxiv.org'];
      expect(isDomainAllowed('gitlab.com', list)).toBe(false);
      expect(isDomainAllowed('198.51.100.1', list)).toBe(false);
      expect(isDomainAllowed('10.20.30.40', list)).toBe(false);
      expect(isDomainAllowed('localhost', list)).toBe(false);
    });
  });

  describe('wildcard prefix pattern', () => {
    it('*.example.com matches sub.example.com', () => {
      expect(isDomainAllowed('sub.example.com', ['*.example.com'])).toBe(true);
      expect(isDomainAllowed('deep.sub.example.com', ['*.example.com'])).toBe(true);
    });

    it('*.example.com does NOT match example.com itself (TLD boundary)', () => {
      expect(isDomainAllowed('example.com', ['*.example.com'])).toBe(false);
    });

    it('*.githubusercontent.com matches raw.githubusercontent.com', () => {
      expect(isDomainAllowed('raw.githubusercontent.com', ['*.githubusercontent.com'])).toBe(true);
      expect(isDomainAllowed('a.b.c.githubusercontent.com', ['*.githubusercontent.com'])).toBe(true);
    });

    it('wildcard does NOT match unrelated domains', () => {
      expect(isDomainAllowed('evil.com', ['*.example.com'])).toBe(false);
    });
  });

  describe('case insensitivity', () => {
    it('matches are case-insensitive', () => {
      const list = ['GitHub.COM', 'ArXiv.ORG'];
      expect(isDomainAllowed('github.com', list)).toBe(true);
      expect(isDomainAllowed('GITHUB.COM', list)).toBe(true);
      expect(isDomainAllowed('github.COM', list)).toBe(true);
      expect(isDomainAllowed('arxiv.org', list)).toBe(true);
    });
  });

  describe('hostname matching ignores port numbers', () => {
    it('matches hostnames regardless of specified port', () => {
      const list = ['github.com', 'example.com'];
      expect(isDomainAllowed('github.com', list)).toBe(true);
      expect(isDomainAllowed('example.com', list)).toBe(true);
    });
  });

  describe('private/LAN ranges — blockable via explicit allowlist', () => {
    it('private ranges can be blocked when allowlist is non-empty', () => {
      const list = ['github.com', 'arxiv.org'];
      expect(isDomainAllowed('198.51.100.213', list)).toBe(false);
      expect(isDomainAllowed('10.20.30.40', list)).toBe(false);
      expect(isDomainAllowed('127.0.0.1', list)).toBe(false);
      expect(isDomainAllowed('localhost', list)).toBe(false);
    });
  });

  describe('safeFetch redirect & header security', () => {
    const origAllowed = [...config.allowedDomains];

    afterEach(() => {
      config.allowedDomains.splice(0, config.allowedDomains.length, ...origAllowed);
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('matches URL hostname without port and strips sensitive headers across origins on redirect', async () => {
      config.allowedDomains.splice(0, config.allowedDomains.length, 'origin-a.example.com', 'origin-b.example.com');
      const calls: Array<{ url: string; headers: Headers }> = [];
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init: { headers: Record<string, string> }) => {
        calls.push({ url, headers: new Headers(init.headers) });
        if (calls.length === 1) {
          return {
            status: 302,
            headers: new Headers({ location: 'https://origin-b.example.com:80/target' }),
          };
        }
        return {
          status: 200,
          url,
          headers: new Headers({ 'content-type': 'text/plain' }),
          body: null,
        };
      }));

      const res = await safeFetch('https://origin-a.example.com:80/start?token=secret123', {
        headers: {
          Authorization: 'Bearer top-secret',
          Cookie: 'sid=abc',
          'X-Custom': 'keep-me',
        },
      });
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(2);
      expect(calls[0].headers.get('Authorization')).toBe('Bearer top-secret');
      expect(calls[1].headers.get('Authorization')).toBeNull();
      expect(calls[1].headers.get('Cookie')).toBeNull();
      expect(calls[1].headers.get('X-Custom')).toBe('keep-me');
    });

    it('redacts query credentials in blocked-domain logs and refuses URL userinfo before logging', async () => {
      config.allowedDomains.splice(0, config.allowedDomains.length, 'allowed.example.com');
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await expect(
        asFetchRequest(() => rawSafeFetch('https://denied.example.com/path?api_key=supersecret'))
      ).rejects.toThrow('fetch_failed');

      const logged = spy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('denied.example.com');
      expect(logged).toContain('domain_not_allowed');
      expect(logged).not.toContain('/path');
      expect(logged).not.toContain('supersecret');
      expect(logged).not.toContain('user:pass');
      spy.mockClear();
      await expect(asFetchRequest(() => rawSafeFetch('https://user:pass@denied.example.com/path?api_key=supersecret'))).rejects.toThrow('fetch_failed');
      const credentialLog = spy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(credentialLog).toContain('credential-free');
      expect(credentialLog).not.toContain('user:pass');
      expect(credentialLog).not.toContain('supersecret');
    });

    it('restricts reddit_fetch URL resolution and share-link redirects to HTTPS Reddit hosts', async () => {
      config.allowedDomains.splice(0, config.allowedDomains.length, 'www.reddit.com', 'old.reddit.com', 'allowed.example.com');
      expect(await resolveRedditJsonUrl('abc1234')).toBe('https://old.reddit.com/comments/abc1234.json');
      expect(await resolveRedditJsonUrl('https://www.reddit.com/r/linux/comments/abc1234/post/?utm_source=share')).toBe(
        'https://old.reddit.com/r/linux/comments/abc1234/post.json'
      );
      await expect(resolveRedditJsonUrl('https://allowed.example.com/reddit.com/r/linux/s/short12')).rejects.toThrow(/reddit\.com/);
      await expect(resolveRedditJsonUrl('http://www.reddit.com/r/linux/comments/abc1234/post/')).rejects.toThrow(/HTTPS/);
      await expect(resolveRedditJsonUrl('https://www.reddit.com:8443/r/linux/comments/abc1234/post/')).rejects.toThrow(/reddit\.com/);

      vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/s/')) {
          return {
            status: 302,
            headers: new Headers({ location: 'https://allowed.example.com/r/linux/comments/abc1234/post/' }),
          };
        }
        return {
          status: 200,
          url,
          headers: new Headers({ 'content-type': 'text/html' }),
          body: null,
        };
      }));
      await expect(asFetchRequest(() => resolveRedditJsonUrl('https://www.reddit.com/r/linux/s/short12'))).rejects.toThrow(/reddit\.com/);
    });
  });
});
