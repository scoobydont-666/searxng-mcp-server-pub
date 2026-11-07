import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/app.js';
import { readConfig, type Config } from '../src/constants.js';
import { MemoryAdmissionStore, type AdmissionStore } from '../src/utils/admission.js';
import { enginePlan, parseEnginePolicy } from '../src/utils/engine-policy.js';
import { requestContext } from '../src/utils/request-context.js';
import { searxQuery } from '../src/utils/searxng-client.js';
import { fixtureEnginePolicy } from './fixtures.js';

const servers: Server[] = [], folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});
async function backend(reply: (engines: string, res: ServerResponse, call: number) => void) {
  const calls: { engines: string; agent: string | undefined; categoryParameters: string[] }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const params = new URLSearchParams(body), engines = params.get('engines') ?? '';
      calls.push({ engines, agent: req.headers['user-agent'], categoryParameters: [...params.keys()].filter(key => key === 'categories' || key.startsWith('category_')) });
      reply(engines, res, calls.length);
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { url: `http://127.0.0.1:${address && typeof address !== 'string' ? address.port : 0}`, calls };
}
function success(res: ServerResponse) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ results: [{ title: 'alternate source result', url: 'https://example.com/' }] }));
}
function search(url: string, options: Partial<Config> = {}, explicit?: string, store: AdmissionStore = new MemoryAdmissionStore(), signal = new AbortController().signal) {
  const cfg = { ...readConfig({}), enginePolicy: fixtureEnginePolicy, searxngUrl: url, ...options };
  return requestContext.run({ config: cfg, store, signal }, () => searxQuery({ query: 'fixture query', engines: explicit }));
}

describe('engine policy validation', () => {
  it('requires a policy at application startup and validates the configured file', () => {
    expect(() => createApplication(readConfig({ SEARXNG_MCP_TOKEN: 'fixture' }), new MemoryAdmissionStore())).toThrow(/ENGINE_POLICY_FILE/);
    const folder = mkdtempSync(join(tmpdir(), 'engine-policy-')); folders.push(folder);
    const path = join(folder, 'policy.json');
    writeFileSync(path, JSON.stringify(fixtureEnginePolicy));
    expect(readConfig({ SEARXNG_MCP_ENGINE_POLICY_FILE: path }).enginePolicy).toEqual(fixtureEnginePolicy);
    writeFileSync(path, '{"credentials":"never print fixture values"}');
    expect(() => readConfig({ SEARXNG_MCP_ENGINE_POLICY_FILE: path })).toThrow('Invalid or unreadable engine policy');
  });

  it('rejects unknown engines, overlapping pools, excess fanout and incomplete categories', () => {
    const unknown = structuredClone(fixtureEnginePolicy); unknown.categories.news.primary = ['unknown'];
    expect(() => parseEnginePolicy(unknown)).toThrow(/outside/);
    const overlap = structuredClone(fixtureEnginePolicy); overlap.categories.general.fallbacks = [['fixture-primary']];
    expect(() => parseEnginePolicy(overlap)).toThrow(/distinct/);
    const large = structuredClone(fixtureEnginePolicy); large.categories.general.primary = Array(5).fill('fixture-primary');
    expect(() => parseEnginePolicy(large)).toThrow();
    const missing = structuredClone(fixtureEnginePolicy) as unknown as { categories: Record<string, unknown> };
    delete missing.categories.images;
    expect(() => parseEnginePolicy(missing)).toThrow();
  });

  it('permits bounded specialty engine choices while rejecting unknown, duplicate and oversized choices', () => {
    const policy = structuredClone(fixtureEnginePolicy);
    policy.engines.push('specialty-map', 'specialty-code', 'specialty-book');
    expect(enginePlan(policy, 'general', 'specialty-map,specialty-code,specialty-book')).toEqual([['specialty-map', 'specialty-code', 'specialty-book']]);
    for (const value of ['', 'unknown', 'fixture-primary,fixture-primary', policy.engines.join(',')]) {
      expect(() => enginePlan(policy, 'general', value)).toThrow();
    }
    expect(() => enginePlan(policy, 'unlisted-category')).toThrow();
  });
});

describe('approved engine fallback over real HTTP', () => {
  it.each([403, 429, 503])('changes engine pools after HTTP %s without changing identity', async status => {
    const upstream = await backend((engines, res) => {
      if (engines === 'fixture-primary') { res.statusCode = status; res.end(); }
      else success(res);
    });
    const result = await search(upstream.url);
    expect(upstream.calls.map(call => call.engines)).toEqual(['fixture-primary', 'fixture-fallback']);
    expect(upstream.calls.flatMap(call => call.categoryParameters)).toEqual([]);
    expect(new Set(upstream.calls.map(call => call.agent))).toEqual(new Set([readConfig({}).userAgent]));
    expect(result.search_policy).toEqual({ attempts: 2, fallback_used: true, engines: ['fixture-fallback'], fallback_reason: `http_${status}` });
  });

  it('charges every pool attempt against the shared budget', async () => {
    const upstream = await backend((_engines, res) => { res.statusCode = 403; res.end(); });
    await expect(search(upstream.url, { searchRate: 1 })).rejects.toMatchObject({ status: 429, code: 'search_capacity_exceeded' });
    expect(upstream.calls).toHaveLength(1);
  });

  it('moves to the next pool after an upstream timeout, inside the caller deadline', async () => {
    const upstream = await backend((engines, res) => { if (engines === 'fixture-fallback') success(res); });
    const result = await search(upstream.url, { searchTimeoutMs: 100 });
    expect(upstream.calls.map(call => call.engines)).toEqual(['fixture-primary', 'fixture-fallback']);
    expect(upstream.calls.flatMap(call => call.categoryParameters)).toEqual([]);
    expect(result.search_policy?.fallback_reason).toBe('upstream_timeout');
  });

  it('falls back for empty unresponsive pools but preserves ordinary empty results', async () => {
    const blocked = await backend((engines, res) => {
      if (engines === 'fixture-primary') res.end(JSON.stringify({ results: [], unresponsive_engines: [['fixture-primary', 'CAPTCHA']] }));
      else success(res);
    });
    expect((await search(blocked.url)).search_policy?.fallback_reason).toBe('empty_unresponsive_pool');
    const empty = await backend((_engines, res) => res.end(JSON.stringify({ results: [] })));
    expect((await search(empty.url)).results).toEqual([]);
    expect(empty.calls).toHaveLength(1);
  });

  it('does not silently change explicit sources or retry permanent errors', async () => {
    const blocked = await backend((_engines, res) => { res.statusCode = 403; res.end(); });
    await expect(search(blocked.url, {}, 'fixture-primary')).rejects.toThrow(/unavailable/);
    expect(blocked.calls).toHaveLength(1);
    const broken = await backend((_engines, res) => { res.statusCode = 500; res.end(); });
    await expect(search(broken.url)).rejects.toThrow(/rejected/);
    expect(broken.calls).toHaveLength(1);
  });

  it('rejects a cancelled context and fails closed before contacting upstream if quota storage fails', async () => {
    const upstream = await backend((_engines, res) => success(res));
    const controller = new AbortController(); controller.abort();
    await expect(search(upstream.url, {}, undefined, new MemoryAdmissionStore(), controller.signal)).rejects.toThrow();
    const broken: AdmissionStore = { take: async () => { throw new Error('offline'); }, ready: async () => false, close: async () => {} };
    await expect(search(upstream.url, {}, undefined, broken)).rejects.toMatchObject({ status: 503, code: 'quota_store_unavailable' });
    expect(upstream.calls).toHaveLength(0);
  });
});
