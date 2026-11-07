import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { fixturePrincipal } from './fixtures.js';
import { ParsePool, type ParseTask } from '../src/utils/parse-pool.js';
import { requestContext } from '../src/utils/request-context.js';

const spinWorker = fileURLToPath(new URL('./fixtures/spin-worker.mjs', import.meta.url));
const asTask = (task: unknown): ParseTask => task as ParseTask;
const pools: ParsePool[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(pools.splice(0).map(pool => pool.close()));
});

async function asPrincipal<T>(id: string, signal: AbortSignal, run: () => Promise<T>, pool = false): Promise<T> {
  const { MemoryAdmissionStore } = await import('../src/utils/admission.js');
  const { readConfig } = await import('../src/constants.js');
  const { requestContext: current } = await import('../src/utils/request-context.js');
  return (pool ? requestContext : current).run({
    signal, store: new MemoryAdmissionStore(), config: readConfig(process.env), principal: { ...fixturePrincipal, id },
  }, run);
}

describe('parse pool principal fairness', () => {
  it('keeps one principal from occupying every worker, so another principal is served at once', async () => {
    const pool = new ParsePool({ size: 2, maxOldGenerationSizeMb: 64, entry: spinWorker, principalConcurrency: 1 });
    pools.push(pool);
    const spinResult = asPrincipal('a', new AbortController().signal, () => pool.run(asTask({ kind: 'spin' }), [], AbortSignal.timeout(500)), true)
      .catch(() => 'aborted');
    const queuedBehind = asPrincipal('a', new AbortController().signal, () => pool.run(asTask({ kind: 'echo' }), [], AbortSignal.timeout(5000)), true);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(pool.stats.busy).toBe(1);
    const other = await asPrincipal('b', new AbortController().signal, () => pool.run(asTask({ kind: 'echo' }), [], AbortSignal.timeout(5000)), true);
    expect(other).toEqual({ echo: 'echo' });
    expect(await spinResult).toBe('aborted');
    await expect(queuedBehind).resolves.toEqual({ echo: 'echo' });
  });

  it('retires the worker with parser_failed when the task cannot be posted, and keeps serving', async () => {
    const pool = new ParsePool({ size: 1, maxOldGenerationSizeMb: 64, entry: spinWorker });
    pools.push(pool);
    await expect(pool.run(asTask({ kind: 'echo', bad: () => 1 }), [], AbortSignal.timeout(5000))).rejects.toMatchObject({ reason: 'parser_failed' });
    expect(pool.stats).toEqual({ workers: 0, busy: 0, queued: 0 });
    await expect(pool.run(asTask({ kind: 'echo' }), [], AbortSignal.timeout(5000))).resolves.toEqual({ echo: 'echo' });
  });
});

describe('fetch reservations', () => {
  const url = 'https://93.184.216.34/page';
  const text = (body: string, headers: Record<string, string> = {}) =>
    () => new Response(body, { headers: { 'content-type': 'text/plain', ...headers } });
  async function load(env: Record<string, string>, respond: () => Response) {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.resetModules();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => respond());
    return (await import('../src/utils/fetch-client.js')).safeFetch;
  }

  it('lets a principal at its concurrency cap wait without blocking another principal', async () => {
    const safeFetch = await load({
      SEARXNG_MCP_FETCH_MAX_BYTES: '1024', SEARXNG_MCP_FETCH_BUFFER_BYTES: '8192', SEARXNG_MCP_FETCH_PRINCIPAL_CONCURRENCY: '1',
    }, text('x'));
    const held = await asPrincipal('a', new AbortController().signal, () => safeFetch(url));
    const second = asPrincipal('a', new AbortController().signal, () => safeFetch(url));
    const other = await asPrincipal('b', AbortSignal.timeout(2000), () => safeFetch(url));
    expect(other.status).toBe(200);
    other.release();
    held.release();
    (await second).release();
  });

  it('lets a waiter whose attempt timeout fires leave the queue so the next grant proceeds', async () => {
    const safeFetch = await load({
      SEARXNG_MCP_FETCH_MAX_BYTES: '1024', SEARXNG_MCP_FETCH_BUFFER_BYTES: '1024', SEARXNG_MCP_FETCH_PRINCIPAL_CONCURRENCY: '8',
    }, text('x'));
    const held = await asPrincipal('a', new AbortController().signal, () => safeFetch(url));
    await expect(asPrincipal('b', new AbortController().signal, () => safeFetch(url, { timeout_ms: 100 }))).rejects.toBeDefined();
    const next = asPrincipal('c', AbortSignal.timeout(3000), () => safeFetch(url));
    held.release();
    const result = await next;
    expect(result.status).toBe(200);
    result.release();
  });

  it('reserves only the Content-Length for an unencoded body', async () => {
    const safeFetch = await load({ SEARXNG_MCP_FETCH_MAX_BYTES: '1024', SEARXNG_MCP_FETCH_BUFFER_BYTES: '1024' },
      text('x'.repeat(10), { 'content-length': '10' }));
    const a = await asPrincipal('a', new AbortController().signal, () => safeFetch(url));
    const b = await asPrincipal('b', AbortSignal.timeout(2000), () => safeFetch(url));
    expect(b.body.byteLength).toBe(10);
    a.release();
    b.release();
  });

  it('fails a body that outgrows its declared Content-Length', async () => {
    const safeFetch = await load({ SEARXNG_MCP_FETCH_MAX_BYTES: '1024', SEARXNG_MCP_FETCH_BUFFER_BYTES: '1024' }, () => {
      const response = new Response('x'.repeat(50), { headers: { 'content-type': 'text/plain' } });
      Object.defineProperty(response, 'headers', { value: new Headers({ 'content-type': 'text/plain', 'content-length': '10' }) });
      return response;
    });
    await expect(asPrincipal('a', new AbortController().signal, () => safeFetch(url))).rejects.toMatchObject({ reason: 'content_length_mismatch' });
  });
});

describe('principal concurrency config', () => {
  it('defaults to 2 and rejects values outside the range', async () => {
    const { readConfig } = await import('../src/constants.js');
    expect(readConfig({}).fetchPrincipalConcurrency).toBe(2);
    expect(() => readConfig({ SEARXNG_MCP_FETCH_PRINCIPAL_CONCURRENCY: '0' })).toThrow(/between/);
  });
});
