import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asFetchRequest } from './fixtures.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let temporary: string;
let previous: string | undefined;
const rules = [{
  id:'publisher', sourceHost:'publisher.example', sourcePath:'/article/{id}', alternatives:[
    {name:'Official feed',kind:'atom',urlTemplate:'https://feed.example/items/{id}'},
    {name:'Official API',kind:'api',urlTemplate:'https://api.example/items/{id}'},
  ],
}];

function stalledChallenge(bytes: number, declaredSize: boolean, signal: AbortSignal | null | undefined,
  onCancel: () => void): Response {
  let onAbort: () => void;
  const body = new ReadableStream({
    start(controller) {
      if (bytes > 0) controller.enqueue(new Uint8Array(bytes));
      onAbort = () => controller.error(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
    },
    cancel() {
      signal?.removeEventListener('abort', onAbort);
      onCancel();
    },
  });
  return new Response(body, { status: 403, headers: declaredSize ? { 'Content-Length': '2048' } : {} });
}

beforeEach(() => {
  vi.resetModules();
  temporary = mkdtempSync(join(tmpdir(), 'searxng-feed-'));
  const policy = join(temporary,'feed.json');
  writeFileSync(policy, JSON.stringify({version:1,maxAlternatives:2,triggerStatuses:[403,429,503],rules}));
  previous = process.env.SEARXNG_MCP_FEED_POLICY_FILE;
  process.env.SEARXNG_MCP_FEED_POLICY_FILE = policy;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (previous === undefined) delete process.env.SEARXNG_MCP_FEED_POLICY_FILE;
  else process.env.SEARXNG_MCP_FEED_POLICY_FILE = previous;
  rmSync(temporary,{recursive:true,force:true});
});

describe('Fetch to alternative-source integration', () => {
  it.each([
    { concurrency: 1, budget: 4096, requests: 1 },
    { concurrency: 2, budget: 1024, requests: 1 },
    { concurrency: 2, budget: 4096, requests: 2 },
  ])('releases blocked bodies before fallback with limits %j', async ({ concurrency, budget, requests }) => {
    vi.stubEnv('SEARXNG_MCP_FETCH_PRINCIPAL_CONCURRENCY', String(concurrency));
    vi.stubEnv('SEARXNG_MCP_FETCH_BUFFER_BYTES', String(budget));
    vi.stubEnv('SEARXNG_MCP_FETCH_MAX_BYTES', '1024');
    vi.stubEnv('SEARXNG_MCP_FETCH_TIMEOUT_MS', '100');
    const { safeFetch, bufferBudget } = await import('../src/utils/fetch-client.js');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input =>
      String(input).startsWith('https://publisher.example/')
        ? new Response('blocked', { status: 403 })
        : new Response('{"items":[{"title":"Metadata"}]}', { headers: { 'Content-Type': 'application/json' } }));
    const results = await Promise.all(Array.from({ length: requests }, (_, index) => asFetchRequest(async () => {
      const result = await safeFetch(`https://publisher.example/article/${index}`);
      result.release();
      return result;
    })));
    for (const result of results) {
      expect(result.status).toBe(200);
      expect(result.alternative?.name).toBe('Official API');
    }
    expect(bufferBudget.inUse).toBe(0);
  });

  it('tries an alternative when a blocking response declares an oversized challenge', async () => {
    const { safeFetch, bufferBudget } = await import('../src/utils/fetch-client.js');
    const cancel = vi.fn();
    const challenge = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(2048))); },
      cancel,
    });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(challenge, { status: 403, headers: { 'Content-Length': '2048' } }))
      .mockResolvedValueOnce(new Response('<feed xmlns="http://www.w3.org/2005/Atom"><title>Publisher</title></feed>',
        { headers: { 'Content-Type': 'application/atom+xml' } }));
    const result = await asFetchRequest(() => safeFetch('https://publisher.example/article/123', { max_bytes: 1024 }));
    try {
      expect(result.status).toBe(200);
      expect(result.alternative?.name).toBe('Official feed');
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      result.release();
    }
    expect(bufferBudget.inUse).toBe(0);
  });

  it('preserves the bounded blocked body when no alternative rule matches', async () => {
    const { safeFetch, bufferBudget } = await import('../src/utils/fetch-client.js');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('original challenge', { status: 403 }));
    const result = await asFetchRequest(() => safeFetch('https://unconfigured.example/page'));
    try {
      expect(result.status).toBe(403);
      expect(new TextDecoder().decode(result.body)).toBe('original challenge');
      expect(result.truncated).toBe(false);
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      result.release();
    }
    expect(bufferBudget.inUse).toBe(0);
  });

  it.each([0, 512, 1024].flatMap(bytes => [true, false].map(declaredSize => ({ bytes, declaredSize }))))(
    'cancels a stalled challenge before fallback with %j', async ({ bytes, declaredSize }) => {
    vi.stubEnv('SEARXNG_MCP_FETCH_TIMEOUT_MS', '100');
    const { safeFetch, bufferBudget } = await import('../src/utils/fetch-client.js');
    const cancel = vi.fn();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (!String(input).startsWith('https://publisher.example/')) {
        return new Response('{"items":[{"title":"Metadata"}]}', { headers: { 'Content-Type': 'application/json' } });
      }
      return stalledChallenge(bytes, declaredSize, init?.signal, cancel);
    });
    const result = await asFetchRequest(() => safeFetch('https://publisher.example/article/123', { max_bytes: 1024 }));
    try {
      expect(result.status).toBe(200);
      expect(result.alternative?.name).toBe('Official API');
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      result.release();
    }
    expect(bufferBudget.inUse).toBe(0);
  });

  it.each([true, false])('caps a stalled preview without an eligible alternative (declared size: %s)', async declaredSize => {
    vi.stubEnv('SEARXNG_MCP_FETCH_TIMEOUT_MS', '100');
    const { safeFetch, bufferBudget } = await import('../src/utils/fetch-client.js');
    const cancel = vi.fn();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) =>
      stalledChallenge(1024, declaredSize, init?.signal, cancel));
    const result = await asFetchRequest(() => safeFetch('https://unconfigured.example/page', { max_bytes: 1024 }));
    try {
      expect(result.status).toBe(403);
      expect(result.alternative).toBeUndefined();
      expect(result.bytes).toBe(1024);
      expect(result.body.byteLength).toBe(1024);
      expect(result.truncated).toBe(true);
      expect(fetch).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      result.release();
    }
    expect(bufferBudget.inUse).toBe(0);
  });

  it('uses the original publisher rule after a redirect to a stalled challenge', async () => {
    const { safeFetch, bufferBudget } = await import('../src/utils/fetch-client.js');
    const cancel = vi.fn();
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://challenge.example/page' } }))
      .mockImplementationOnce(async (_input, init) => stalledChallenge(0, false, init?.signal, cancel))
      .mockResolvedValueOnce(new Response('<feed xmlns="http://www.w3.org/2005/Atom"><title>Publisher</title></feed>',
        { headers: { 'Content-Type': 'application/atom+xml' } }));
    const result = await asFetchRequest(() => safeFetch('https://publisher.example/article/123', { timeout_ms: 100 }));
    try {
      expect(result.status).toBe(200);
      expect(result.alternative).toMatchObject({ name: 'Official feed', original_url: 'https://publisher.example/article/123', original_status: 403 });
      expect(fetch.mock.calls.map(call => String(call[0]))).toEqual([
        'https://publisher.example/article/123', 'https://challenge.example/page', 'https://feed.example/items/123',
      ]);
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      result.release();
    }
    expect(bufferBudget.inUse).toBe(0);
  });

  it('retains the original body when a 429 makes every configured alternative ineligible', async () => {
    writeFileSync(process.env.SEARXNG_MCP_FEED_POLICY_FILE!, JSON.stringify({
      version: 1, maxAlternatives: 2, triggerStatuses: [403, 429, 503], rules: [{
        ...rules[0], alternatives: [{ name: 'Same-origin feed', kind: 'atom', urlTemplate: 'https://publisher.example/feed/{id}' }],
      }],
    }));
    const { safeFetch, bufferBudget } = await import('../src/utils/fetch-client.js');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('rate limited', { status: 429 }));
    const result = await asFetchRequest(() => safeFetch('https://publisher.example/article/123'));
    try {
      expect(result.status).toBe(429);
      expect(result.alternative).toBeUndefined();
      expect(new TextDecoder().decode(result.body)).toBe('rate limited');
      expect(result.truncated).toBe(false);
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      result.release();
    }
    expect(bufferBudget.inUse).toBe(0);
  });

  it('uses the official Atom source after a block, with provenance and no caller credentials', async () => {
    const {safeFetch: rawSafeFetch} = await import('../src/utils/fetch-client.js');
    const safeFetch = (url: string, opts?: Parameters<typeof rawSafeFetch>[1]) => asFetchRequest(() => rawSafeFetch(url, opts));
    const {config} = await import('../src/constants.js');
    const fetch = vi.spyOn(globalThis,'fetch')
      .mockResolvedValueOnce(new Response('challenge',{status:403,headers:{server:'cloudflare'}}))
      .mockResolvedValueOnce(new Response('<feed xmlns="http://www.w3.org/2005/Atom"><title>Publisher</title></feed>',
        {headers:{'Content-Type':'application/atom+xml'}}));
    const result = await safeFetch('https://publisher.example/article/123?secret=not-forwarded',
      {headers:{Authorization:'Bearer private',Cookie:'session=private','X-Caller':'private'}});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe('https://feed.example/items/123');
    const headers = new Headers(fetch.mock.calls[1][1]?.headers);
    expect(headers.get('User-Agent')).toBe(config.userAgent);
    for (const name of ['Authorization','Cookie','X-Caller','Referer']) expect(headers.has(name)).toBe(false);
    expect(result.alternative).toMatchObject({name:'Official feed',kind:'atom',original_status:403,
      semantics:'alternative_source_not_original_page'});
    expect(result.url_final).toBe('https://feed.example/items/123');
  });

  it('rejects a 200 HTML challenge at a feed URL and tries the next configured API', async () => {
    const {safeFetch: rawSafeFetch} = await import('../src/utils/fetch-client.js');
    const safeFetch = (url: string, opts?: Parameters<typeof rawSafeFetch>[1]) => asFetchRequest(() => rawSafeFetch(url, opts));
    const fetch = vi.spyOn(globalThis,'fetch')
      .mockResolvedValueOnce(new Response('blocked',{status:503}))
      .mockResolvedValueOnce(new Response('<html>Just a moment</html>',{headers:{'Content-Type':'text/html'}}))
      .mockResolvedValueOnce(new Response('{"items":[{"title":"Metadata"}]}',{headers:{'Content-Type':'application/json'}}));
    const result = await safeFetch('https://publisher.example/article/123');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result.alternative?.name).toBe('Official API');
  });

  it('retains the original block when every alternative fails and never loops', async () => {
    const {safeFetch: rawSafeFetch} = await import('../src/utils/fetch-client.js');
    const safeFetch = (url: string, opts?: Parameters<typeof rawSafeFetch>[1]) => asFetchRequest(() => rawSafeFetch(url, opts));
    const fetch = vi.spyOn(globalThis,'fetch').mockImplementation(async () => new Response('blocked',{status:429}));
    const result = await safeFetch('https://publisher.example/article/123');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result.status).toBe(429);
    expect(result.alternative).toBeUndefined();
    expect(result.body.byteLength).toBe(0);
    expect(result.bytes).toBe(0);
    expect(result.truncated).toBe(true);
  });

  it('does not treat a redirected alternative as the official source', async () => {
    const {safeFetch: rawSafeFetch} = await import('../src/utils/fetch-client.js');
    const safeFetch = (url: string, opts?: Parameters<typeof rawSafeFetch>[1]) => asFetchRequest(() => rawSafeFetch(url, opts));
    const fetch = vi.spyOn(globalThis,'fetch')
      .mockResolvedValueOnce(new Response('blocked',{status:403}))
      .mockResolvedValueOnce(new Response(null,{status:302,headers:{location:'https://other.example/stolen'}}))
      .mockResolvedValueOnce(new Response('<feed xmlns="http://www.w3.org/2005/Atom"><title>Elsewhere</title></feed>',
        {headers:{'Content-Type':'application/atom+xml'}}))
      .mockResolvedValueOnce(new Response('{"error":"unavailable"}',{headers:{'Content-Type':'application/json'}}));
    const result = await safeFetch('https://publisher.example/article/123');
    expect(result.alternative).toBeUndefined();
    expect(result.status).toBe(403);
    expect(String(fetch.mock.calls[2][0])).toBe('https://other.example/stolen');
  });

  it('rejects an alternative API body that is only an error or challenge', async () => {
    const {isAlternativeContent} = await import('../src/utils/feed-fallback.js');
    const body = (value: string) => new TextEncoder().encode(value).buffer;
    expect(await isAlternativeContent('api','application/json',body('{"items":[{"title":"Metadata"}]}'))).toBe(true);
    expect(await isAlternativeContent('api','application/json',body('{"message":"captcha"}'))).toBe(false);
    expect(await isAlternativeContent('api','application/json',body('[{"captcha":true}]'))).toBe(false);
    expect(await isAlternativeContent('api','application/problem+json',body('{"title":"nope"}'))).toBe(false);
  });

  it('refuses a feed redirect into a private network before connecting to that address', async () => {
    const {safeFetch: rawSafeFetch} = await import('../src/utils/fetch-client.js');
    const safeFetch = (url: string, opts?: Parameters<typeof rawSafeFetch>[1]) => asFetchRequest(() => rawSafeFetch(url, opts));
    const fetch = vi.spyOn(globalThis,'fetch')
      .mockResolvedValueOnce(new Response('blocked',{status:403}))
      .mockResolvedValueOnce(new Response(null,{status:302,headers:{location:'http://169.254.169.254/latest/meta-data/'}}))
      .mockResolvedValueOnce(new Response('{"error":"unavailable"}',{headers:{'Content-Type':'application/json'}}));
    const result = await safeFetch('https://publisher.example/article/123');
    expect(result.status).toBe(403);
    expect(result.alternative).toBeUndefined();
    expect(fetch.mock.calls.map(call => String(call[0]))).toEqual([
      'https://publisher.example/article/123','https://feed.example/items/123','https://api.example/items/123',
    ]);
  });

  it('does not follow alternative feeds for an authentication failure or a non-GET request', async () => {
    const {safeFetch: rawSafeFetch} = await import('../src/utils/fetch-client.js');
    const safeFetch = (url: string, opts?: Parameters<typeof rawSafeFetch>[1]) => asFetchRequest(() => rawSafeFetch(url, opts));
    const fetch = vi.spyOn(globalThis,'fetch')
      .mockResolvedValueOnce(new Response('unauthorized',{status:401}))
      .mockResolvedValueOnce(new Response('blocked',{status:403}));
    expect((await safeFetch('https://publisher.example/article/123')).status).toBe(401);
    expect((await safeFetch('https://publisher.example/article/123',{method:'HEAD'})).status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
