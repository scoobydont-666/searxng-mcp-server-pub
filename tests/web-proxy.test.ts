import { fixtureEnginePolicy } from './fixtures.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createApplication } from '../src/app.js';
import { readConfig, type Config } from '../src/constants.js';
import { digestToken } from '../src/middleware/auth.js';
import { MemoryAdmissionStore, type AdmissionStore } from '../src/utils/admission.js';
import { createWebApplication, readWebConfig, type WebConfig } from '../src/web-proxy.js';

const servers: Server[] = [];
const publicOrigin = 'https://search.example.test';
function clientFetch(input: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('X-Forwarded-User')) headers.set('X-Forwarded-User', 'fixture-user');
  return fetch(input, { ...init, headers });
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${address && typeof address !== 'string' ? address.port : 0}`;
}
async function backend(handler?: (req: IncomingMessage, res: ServerResponse, form: URLSearchParams) => void) {
  let searches = 0;
  const url = await listen(createServer((req, res) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      const target = new URL(req.url!, 'http://fixture.test');
      const form = new URLSearchParams(data);
      if (target.pathname === '/healthz') { res.end('ok'); return; }
      if (target.pathname === '/search') searches++;
      if (handler) { handler(req, res, form); return; }
      if (form.get('format') === 'json') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ results: [{ title: 'result', url: 'https://example.com/' }] }));
      } else {
        res.setHeader('Content-Type', target.pathname.endsWith('.css') ? 'text/css' : 'text/html');
        res.end('<!doctype html><title>Search</title>');
      }
    });
  }));
  return { url, searches: () => searches };
}
async function gateway(upstreamUrl: string, cfg: Partial<Config> = {}, store: AdmissionStore = new MemoryAdmissionStore(), extra: Partial<WebConfig> = {}) {
  const config = { ...readConfig({}), enginePolicy: fixtureEnginePolicy, ...cfg };
  const service = createWebApplication(config, { upstreamUrl, publicOrigin, port: 8088, maxResponseBytes: 1024 * 1024, userRateLimit: 60, userRateLimitWindowSeconds: 60, ...extra }, store);
  return { ...service, url: await listen(createServer(service.app)) };
}
function formRequest(url: string, path: string, form: Record<string, string>) {
  return clientFetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
}
function rawGet(url: string, path: string): Promise<number> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: target.hostname, port: target.port, path }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
    req.on('error', reject); req.end();
  });
}

describe('browser gateway configuration and routing', () => {
  it('requires shared Redis and explicit fixed upstream and public origins at startup', () => {
    expect(() => readWebConfig(readConfig({}), {})).toThrow(/requires/);
    const cfg = { ...readConfig({ SEARXNG_MCP_REDIS_URL: 'redis://127.0.0.1:6379' }), enginePolicy: fixtureEnginePolicy };
    const valid = { SEARXNG_WEB_UPSTREAM_URL: 'http://html:8080', SEARXNG_WEB_PUBLIC_ORIGIN: publicOrigin };
    expect(readWebConfig(cfg, valid).port).toBe(8088);
    for (const upstream of ['http://user:secret@html/', 'http://html/other', 'file:///etc/passwd']) {
      expect(() => readWebConfig(cfg, { ...valid, SEARXNG_WEB_UPSTREAM_URL: upstream })).toThrow();
    }
    expect(() => readWebConfig(cfg, { ...valid, SEARXNG_WEB_PUBLIC_ORIGIN: 'http://search.example.test' })).toThrow();
  });

  it('allows UI pages/assets and denies auxiliary fetching, introspection and encoded traversal routes', async () => {
    const up = await backend(), web = await gateway(up.url);
    expect((await clientFetch(web.url + '/')).status).toBe(200);
    expect((await clientFetch(web.url + '/static/themes/simple/searxng.css?v=1')).status).toBe(200);
    for (const path of ['/autocompleter?q=x', '/image?url=https://example.com', '/favicon_proxy?url=x', '/metrics', '/config', '/stats', '/healthz']) {
      expect((await clientFetch(web.url + path)).status, path).toBe(404);
    }
    for (const path of ['/static/%2e%2e/search?q=x', '//search?q=x', '/static/../search?q=x', '/static/a%2fb.js']) {
      expect(await rawGet(web.url, path), path).toBe(404);
    }
    expect((await clientFetch(web.url + '/search?q=x', { method: 'HEAD' })).status).toBe(405);
    expect(up.searches()).toBe(0);
  });

  it('blocks JSON format in query/form and forces HTML even if Accept requests JSON', async () => {
    const up = await backend(), web = await gateway(up.url);
    for (const path of ['/search?q=x&format=json', '/?q=x&format=csv', '/search?q=x&format=html&format=json']) {
      expect((await clientFetch(web.url + path)).status).toBe(400);
    }
    expect((await formRequest(web.url, '/search', { q: 'x', format: 'json' })).status).toBe(400);
    expect((await formRequest(web.url, '/', { q: 'x', format: 'json' })).status).toBe(400);
    expect((await clientFetch(web.url + '/search?q=x', { headers: { Accept: 'application/json' } })).headers.get('content-type')).toMatch(/^text\/html/);
    expect(up.searches()).toBe(1);
  });

  it('caps form bodies, rejects non-form requests, and rejects engine bangs', async () => {
    const up = await backend(), web = await gateway(up.url);
    expect((await formRequest(web.url, '/search', { q: 'x'.repeat(70000) })).status).toBe(413);
    expect((await clientFetch(web.url + '/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"q":"x"}' })).status).toBe(415);
    expect((await formRequest(web.url, '/search', { q: '!google x' })).status).toBe(400);
    expect((await formRequest(web.url, '/search', { q: 'term\u0085!general' })).status).toBe(400);
    expect((await formRequest(web.url, '/search', { q: 'term\u001c!general' })).status).toBe(400);
    expect((await formRequest(web.url, '/search', { q: 'term <9999' })).status).toBe(400);
    expect(up.searches()).toBe(0);
  });
});

describe('browser gateway shared admission', () => {
  it('requires an authenticated proxy identity but keeps private probes available', async () => {
    const up = await backend(), web = await gateway(up.url);
    expect((await fetch(web.url + '/search?q=one')).status).toBe(401);
    expect((await clientFetch(web.url + '/search?q=one', { headers: { 'X-Forwarded-User': 'first,second' } })).status).toBe(401);
    expect((await fetch(web.url + '/health')).status).toBe(200);
    expect((await fetch(web.url + '/ready')).status).toBe(200);
    expect(up.searches()).toBe(0);
  });

  it('shares per-user quotas across two guards without writing plaintext identities to the store', async () => {
    const up = await backend(), memory = new MemoryAdmissionStore(), keys: string[] = [];
    const store: AdmissionStore = { take: async (key, limit, window) => { keys.push(key); return memory.take(key, limit, window); }, ready: () => memory.ready(), close: () => memory.close() };
    const one = await gateway(up.url, {}, store, { userRateLimit: 1 });
    const two = await gateway(up.url, {}, store, { userRateLimit: 1 });
    const identity = 'opaque-subject-fixture';
    const headers = { 'X-Forwarded-User': identity };
    expect((await clientFetch(one.url + '/search?q=one', { headers })).status).toBe(200);
    expect((await clientFetch(two.url + '/search?q=two', { headers })).status).toBe(429);
    expect((await clientFetch(two.url + '/search?q=three', { headers: { 'X-Forwarded-User': 'another-subject' } })).status).toBe(200);
    expect(keys.some(key => key.endsWith(createHash('sha256').update(identity).digest('hex')))).toBe(true);
    expect(keys.some(key => key.includes(identity))).toBe(false);
    expect(up.searches()).toBe(2);
  });

  it.each([
    ['GET', '/search?q=one'], ['GET', '/?q=one'], ['POST', '/search'], ['POST', '/'],
  ])('charges the shared search budget for %s %s', async (method, path) => {
    const up = await backend(), web = await gateway(up.url, { searchRate: 1 });
    const call = () => method === 'POST' ? formRequest(web.url, path, { q: 'one' }) : clientFetch(web.url + path);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
    expect(up.searches()).toBe(1);
  });

  it('charges root POST even without q and shares the cap with API and MCP', async () => {
    const up = await backend(), store = new MemoryAdmissionStore();
    const cfg = { ...readConfig({}), enginePolicy: fixtureEnginePolicy, searxngUrl: up.url, apiEnabled: true, searchRate: 2 };
    const web = await gateway(up.url, cfg, store);
    const token = 'fixture-web-budget';
    const api = createApplication(cfg, store, [{ id: 'fixture', scopes: ['api:search', 'mcp:search'], rate_limit: 100, token_sha256: digestToken(token) }]);
    const apiUrl = await listen(createServer(api.app));
    expect((await fetch(apiUrl + '/api/v1/search?q=one', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await formRequest(web.url, '/', {})).status).toBe(200);
    const denied = await fetch(apiUrl + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search', arguments: { query: 'three' } } }) });
    expect((await denied.json()).result.isError).toBe(true);
    expect(up.searches()).toBe(2);
  });

  it('fails closed on quota-store failure and reports unready', async () => {
    const up = await backend();
    const store: AdmissionStore = { take: async () => { throw new Error('offline'); }, ready: async () => false, close: async () => {} };
    const web = await gateway(up.url, {}, store);
    expect((await clientFetch(web.url + '/search?q=one')).status).toBe(503);
    expect((await clientFetch(web.url + '/ready')).status).toBe(503);
    expect((await clientFetch(web.url + '/health')).status).toBe(200);
    expect(up.searches()).toBe(0);
  });

  it('overrides engine preference injection with the bounded policy and selected category', async () => {
    const seen: { engines: string | null; category: string | null; cookie?: string; preferences: string | null }[] = [];
    const up = await backend((req, res, body) => {
      const params = req.method === 'POST' ? body : new URL(req.url!, 'http://fixture.test').searchParams;
      seen.push({ engines: params.get('engines'), category: params.get('categories'), cookie: req.headers.cookie, preferences: params.get('preferences') ?? params.get('timeout_limit') });
      res.setHeader('Content-Type', 'text/html'); res.end('ok');
    });
    const policy = structuredClone(fixtureEnginePolicy);
    policy.categories.news = { primary: ['fixture-fallback'], fallbacks: [] };
    const web = await gateway(up.url, { enginePolicy: policy });
    expect((await clientFetch(web.url + '/search?q=x&enabled_engines=unknown&preferences=packed&timeout_limit=Infinity', { headers: { Cookie: 'enabled_engines=unknown; categories=news; language=en' } })).status).toBe(200);
    expect(seen[0]).toEqual({ engines: 'fixture-primary', category: null, cookie: 'language=en', preferences: null });
    expect((await formRequest(web.url, '/search', { q: 'x', category_news: '1', preferences: 'packed' })).status).toBe(200);
    expect(seen[1]).toMatchObject({ engines: 'fixture-fallback', category: null, preferences: null });
    expect((await clientFetch(web.url + '/search?q=x&engines=unknown')).status).toBe(400);
    expect(up.searches()).toBe(2);
  });

  it('moves to an approved HTML pool on a blocking status and charges both attempts', async () => {
    const engines: string[] = [];
    const up = await backend((req, res) => {
      const selected = new URL(req.url!, 'http://fixture.test').searchParams.get('engines')!;
      engines.push(selected);
      res.setHeader('Content-Type', 'text/html');
      res.statusCode = selected === 'fixture-primary' ? 403 : 200;
      res.end('page');
    });
    const web = await gateway(up.url, { searchRate: 2 });
    const response = await clientFetch(web.url + '/search?q=x');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-searxng-fallback')).toBe('true');
    expect(response.headers.get('x-searxng-attempts')).toBe('2');
    expect(engines).toEqual(['fixture-primary', 'fixture-fallback']);
    expect((await clientFetch(web.url + '/search?q=again')).status).toBe(429);
    expect(up.searches()).toBe(2);
  });

  it('can use another HTML pool on a header timeout without interpreting ordinary HTML', async () => {
    const up = await backend((req, res) => {
      const selected = new URL(req.url!, 'http://fixture.test').searchParams.get('engines');
      if (selected === 'fixture-primary') return;
      res.setHeader('Content-Type', 'text/html'); res.end('no results');
    });
    const web = await gateway(up.url, { searchTimeoutMs: 100, requestTimeoutMs: 1000 });
    const response = await clientFetch(web.url + '/search?q=x');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('no results');
    expect(up.searches()).toBe(2);
  });
});

describe('browser gateway credential and response boundaries', () => {
  it('forwards only selected preference cookies and a configured agent', async () => {
    let received: IncomingMessage['headers'] = {};
    const up = await backend((req, res) => {
      received = req.headers;
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Set-Cookie', ['_oauth2_proxy=forbidden; Path=/', 'tokens=forbidden; Path=/', 'language=en; Domain=example.test; Path=/preferences; Max-Age=100']);
      res.end('<html>preferences</html>');
    });
    const web = await gateway(up.url);
    const response = await clientFetch(web.url + '/preferences', { headers: {
      Authorization: 'Bearer fixture', Cookie: '_oauth2_proxy=fixture; tokens=private; language=en; autocomplete=google',
      'X-Forwarded-For': '192.0.2.1', 'X-Forwarded-User': 'fixture', 'X-Auth-Request-Email': 'fixture@example.test',
      'User-Agent': 'caller-agent',
    } });
    expect(response.status).toBe(200);
    expect(received.authorization).toBeUndefined();
    expect(received['x-forwarded-for']).toBeUndefined();
    expect(received['x-forwarded-user']).toBeUndefined();
    expect(received['x-auth-request-email']).toBeUndefined();
    expect(received.cookie).toBe('language=en');
    expect(received['user-agent']).toBe(readConfig({}).userAgent);
    expect(response.headers.getSetCookie()).toEqual(['language=en; Max-Age=100; Path=/; Secure; SameSite=Lax']);
  });

  it('rewrites a configured public-origin redirect and never follows an external redirect', async () => {
    let externalHits = 0;
    const outside = await backend((_req, res) => { externalHits++; res.end('outside'); });
    let location = publicOrigin + '/';
    const up = await backend((_req, res) => { res.writeHead(302, { Location: location }); res.end(); });
    const web = await gateway(up.url);
    const accepted = await clientFetch(web.url + '/preferences', { redirect: 'manual' });
    expect(accepted.status).toBe(302); expect(accepted.headers.get('location')).toBe('/');
    location = outside.url + '/';
    expect((await clientFetch(web.url + '/preferences', { redirect: 'manual' })).status).toBe(502);
    expect(externalHits).toBe(0);
  });

  it('rejects JSON from a misconfigured HTML backend and caps decoded streaming responses', async () => {
    const json = await backend((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"results":[]}'); });
    const bad = await gateway(json.url);
    expect((await clientFetch(bad.url + '/search?q=x')).status).toBe(502);
    const large = await backend((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.write('x'.repeat(2048)); res.end(); });
    const capped = await gateway(large.url, {}, undefined, { maxResponseBytes: 1024 });
    expect((await clientFetch(capped.url + '/')).status).toBe(502);
  });

  it('bounds an upstream body that never arrives and drains inflight work', async () => {
    const slow = await backend((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.flushHeaders(); });
    const timed = await gateway(slow.url, { requestTimeoutMs: 100 });
    expect((await clientFetch(timed.url + '/search?q=x')).status).toBe(504);
    let finish!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const held = await backend((_req, res) => { finish = () => { res.setHeader('Content-Type', 'text/html'); res.end('ok'); }; entered(); });
    const web = await gateway(held.url, { maxInflight: 1 });
    const first = clientFetch(web.url + '/search?q=one');
    await waiting;
    expect((await clientFetch(web.url + '/search?q=two')).status).toBe(503);
    web.drain();
    expect((await clientFetch(web.url + '/ready')).status).toBe(503);
    finish();
    expect((await first).status).toBe(200);
    expect((await clientFetch(web.url + '/')).status).toBe(503);
    expect(web.activeRequests()).toBe(0);
  });
});
