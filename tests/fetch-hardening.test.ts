import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createServer as httpServer } from 'node:http';
import { fixturePrincipal, fixtureEnginePolicy } from './fixtures.js';

const TOKEN = 'fixture-client-secret';
const PUBLIC_URL = 'https://93.184.216.34/page';
const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.doUnmock('../src/utils/parse-pool.js');
  vi.resetModules();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});

async function inContext<T>(signal: AbortSignal, run: () => Promise<T>, deadline?: number): Promise<T> {
  const { requestContext } = await import('../src/utils/request-context.js');
  const { MemoryAdmissionStore } = await import('../src/utils/admission.js');
  const { readConfig } = await import('../src/constants.js');
  return requestContext.run({
    signal, deadline, store: new MemoryAdmissionStore(), config: readConfig(process.env), principal: fixturePrincipal,
  }, run);
}

async function startApp() {
  const { createApplication } = await import('../src/app.js');
  const { readConfig } = await import('../src/constants.js');
  const { MemoryAdmissionStore } = await import('../src/utils/admission.js');
  const { digestToken } = await import('../src/middleware/auth.js');
  const cfg = { ...readConfig({}), enginePolicy: fixtureEnginePolicy, fetchEnabled: true, allowedDomains: ['example.com'] };
  const principal = { id: 'client', token_sha256: digestToken(TOKEN), scopes: ['mcp:fetch'], rate_limit: 1000 };
  const server = httpServer(createApplication(cfg, new MemoryAdmissionStore(), [principal]).app);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address && typeof address !== 'string' ? address.port : 0}`;
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => (
    String(input).startsWith(url) ? original(input, init) : new Response('%PDF-fixture', { headers: { 'content-type': 'application/pdf' } })
  ));
  return url;
}

function callTool(url: string, name: string, args: Record<string, unknown>) {
  return fetch(url + '/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }).then(response => response.json() as Promise<{ result?: { content: { text: string }[] } }>);
}

describe('fetch byte budget across parsing', () => {
  it('keeps the reservation held while a PDF parses and returns it afterwards', async () => {
    let finish!: () => void;
    const started = new Promise<void>(resolve => {
      vi.doMock('../src/utils/parse-pool.js', async importOriginal => ({
        ...(await importOriginal<typeof import('../src/utils/parse-pool.js')>()),
        parsePdfInWorker: () => new Promise(done => {
          resolve();
          finish = () => done({ pages: 1, info: {}, metadata: null, text: 'ok' });
        }),
      }));
    });
    const url = await startApp();
    const { bufferBudget } = await import('../src/utils/fetch-client.js');
    expect(bufferBudget.inUse).toBe(0);
    const pending = callTool(url, 'fetch_pdf', { url: 'https://example.com/a.pdf' });
    await started;
    expect(bufferBudget.inUse).toBeGreaterThan(0);
    finish();
    const payload = JSON.parse((await pending).result!.content[0].text);
    expect(payload.text).toBe('ok');
    expect(bufferBudget.inUse).toBe(0);
  });

  it('accepts fetch_pdf max_bytes above the server limit and clamps it', async () => {
    vi.stubEnv('SEARXNG_MCP_FETCH_MAX_BYTES', '2048');
    vi.stubEnv('SEARXNG_MCP_FETCH_BUFFER_BYTES', '4096');
    vi.resetModules();
    const { safeFetch } = await import('../src/utils/fetch-client.js');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('x'.repeat(5000), { headers: { 'content-type': 'application/pdf' } }));
    const result = await inContext(new AbortController().signal, () => safeFetch(PUBLIC_URL, { max_bytes: 100 * 1024 * 1024 }));
    expect(result.bytes).toBe(2048);
    expect(result.truncated).toBe(true);
    result.release();
  });
});

describe('request signal listeners', () => {
  it('does not accumulate abort listeners on the request signal across successful fetches', async () => {
    vi.stubEnv('SEARXNG_MCP_FETCH_PRINCIPAL_CONCURRENCY', '8');
    vi.resetModules();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('hello', { headers: { 'content-type': 'text/plain' } }));
    const { safeFetch } = await import('../src/utils/fetch-client.js');
    const request = new AbortController();
    let live = 0;
    const add = request.signal.addEventListener.bind(request.signal);
    const remove = request.signal.removeEventListener.bind(request.signal);
    request.signal.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'abort') live++;
      return (add as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof add;
    request.signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'abort') live--;
      return (remove as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof remove;
    await inContext(request.signal, async () => {
      for (let i = 0; i < 25; i++) (await safeFetch(PUBLIC_URL)).release();
    });
    expect(live).toBe(0);
  });
});

describe('parse deadline', () => {
  it('aborts at the remaining request time rather than a fresh fetch timeout', async () => {
    vi.resetModules();
    const { parseSignal } = await import('../src/utils/parse-pool.js');
    const request = new AbortController();
    const signal = await inContext(request.signal, async () => parseSignal(), Date.now() + 80);
    expect(signal.aborted).toBe(false);
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    expect(request.signal.aborted).toBe(false);
    expect(signal.aborted).toBe(true);
  });

  it('is aborted once the request deadline has passed', async () => {
    vi.resetModules();
    const { parseSignal } = await import('../src/utils/parse-pool.js');
    const signal = await inContext(new AbortController().signal, async () => parseSignal(), Date.now() - 1);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(signal.aborted).toBe(true);
  });
});
