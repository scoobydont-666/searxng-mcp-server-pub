import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createServer as httpServer } from 'node:http';
import { fixturePrincipal } from './fixtures.js';
import { fixtureEnginePolicy } from './fixtures.js';
import { twoPagePdf } from './fixtures/pdf.js';

const TOKEN = 'fixture-client-secret';
const PUBLIC_URL = 'https://93.184.216.34/page';
const BATCH_URL = 'https://example.com/page';
const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});

async function withSignal<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  const { requestContext } = await import('../src/utils/request-context.js');
  const { MemoryAdmissionStore } = await import('../src/utils/admission.js');
  const { readConfig } = await import('../src/constants.js');
  return requestContext.run({
    signal, store: new MemoryAdmissionStore(), config: readConfig(process.env), principal: fixturePrincipal,
  }, run);
}

/** Small budget: four reservations of 1 KiB each. */
async function smallBudgetFetch() {
  vi.stubEnv('SEARXNG_MCP_FETCH_MAX_BYTES', '1024');
  vi.stubEnv('SEARXNG_MCP_FETCH_BUFFER_BYTES', '4096');
  vi.stubEnv('SEARXNG_MCP_FETCH_PRINCIPAL_CONCURRENCY', '8');
  vi.resetModules();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('x'.repeat(10), { headers: { 'content-type': 'text/plain' } }));
  return (await import('../src/utils/fetch-client.js')).safeFetch;
}

describe('process-wide fetch buffer budget', () => {
  it('blocks a fetch that would exceed the budget until a held body is released or the request aborts', async () => {
    const safeFetch = await smallBudgetFetch();
    const held = [];
    for (let i = 0; i < 4; i++) held.push(await withSignal(new AbortController().signal, () => safeFetch(PUBLIC_URL)));

    const deadline = new AbortController();
    const blocked = withSignal(deadline.signal, () => safeFetch(PUBLIC_URL));
    setTimeout(() => deadline.abort(new Error('request deadline')), 50);
    await expect(blocked).rejects.toThrow('request deadline');

    held[0].release();
    const admitted = await withSignal(new AbortController().signal, () => safeFetch(PUBLIC_URL));
    expect(admitted.status).toBe(200);
    admitted.release();
    held.slice(1).forEach(result => result.release());
  });

  it('returns each reservation on release so sequential fetches never exhaust the budget', async () => {
    const safeFetch = await smallBudgetFetch();
    for (let i = 0; i < 12; i++) {
      const result = await withSignal(new AbortController().signal, () => safeFetch(PUBLIC_URL));
      expect(result.body.byteLength).toBe(10);
      result.release();
    }
  });

  it('keeps the budget at least as large as one maximum-size body', async () => {
    vi.stubEnv('SEARXNG_MCP_FETCH_MAX_BYTES', '8192');
    vi.stubEnv('SEARXNG_MCP_FETCH_BUFFER_BYTES', '4096');
  vi.stubEnv('SEARXNG_MCP_FETCH_PRINCIPAL_CONCURRENCY', '8');
    vi.resetModules();
    await expect(import('../src/constants.js')).rejects.toThrow(/FETCH_BUFFER_BYTES must be at least/);
  });
});

async function appWithFetch(body: () => Response, principalScopes: ('mcp:fetch')[] = ['mcp:fetch']) {
  const { createApplication } = await import('../src/app.js');
  const { readConfig } = await import('../src/constants.js');
  const { MemoryAdmissionStore } = await import('../src/utils/admission.js');
  const { digestToken } = await import('../src/middleware/auth.js');
  const cfg = { ...readConfig({}), enginePolicy: fixtureEnginePolicy, fetchEnabled: true, allowedDomains: ['example.com'] };
  const principal = { id: 'client', token_sha256: digestToken(TOKEN), scopes: principalScopes, rate_limit: 1000 };
  const service = createApplication(cfg, new MemoryAdmissionStore(), [principal]);
  const server = httpServer(service.app);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address && typeof address !== 'string' ? address.port : 0}`;
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => (
    String(input).startsWith(url) ? original(input, init) : body()
  ));
  return { url };
}

async function callTool(url: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(url + '/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await response.json()) as { result?: { isError?: boolean; content: { text: string }[] }; error?: unknown };
}

describe('fetch tools through the MCP surface', () => {
  it('reports an oversize HTML document from the bounded text path without article extraction', async () => {
    const article = '<html><body><article><h1>Heading</h1><p>' + 'Readable paragraph text. '.repeat(100_000) + '</p></article></body></html>';
    const { url } = await appWithFetch(() => new Response(article, { headers: { 'content-type': 'text/html' } }));
    const result = (await callTool(url, 'fetch_url', { url: BATCH_URL })).result!;
    const payload = JSON.parse(result.content[0].text);
    expect(payload.extraction).toBe('oversize-html-text');
    expect(payload.content).toContain('Readable paragraph text.');
    expect(payload.title).toBeNull();
  });

  it('turns an invalid PDF into a bounded parse failure without stopping the request', async () => {
    const { url } = await appWithFetch(() => new Response('%PDF-1.4 not really a document', { headers: { 'content-type': 'application/pdf' } }));
    const result = (await callTool(url, 'fetch_pdf', { url: BATCH_URL })).result!;
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({ status: 200, error: 'pdf_parse_failed' });
    expect(JSON.stringify(payload)).not.toMatch(/not really a document/);
  });

  it('reports incomplete PDF extraction as a sanitized failure and releases its budget', async () => {
    const { url } = await appWithFetch(() => new Response(twoPagePdf('missing').buffer, { headers: { 'content-type': 'application/pdf' } }));
    const result = (await callTool(url, 'fetch_pdf', { url: BATCH_URL })).result!;
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({ status: 200, error: 'pdf_parse_failed' });
    expect(payload).not.toHaveProperty('text');
    expect(JSON.stringify(payload)).not.toContain('First page intact');
    const { bufferBudget } = await import('../src/utils/fetch-client.js');
    expect(bufferBudget.inUse).toBe(0);
  });

  it('caps fetch_batch at five URLs', async () => {
    const { url } = await appWithFetch(() => new Response('ok', { headers: { 'content-type': 'text/plain' } }));
    const urls = Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`);
    const response = await callTool(url, 'fetch_batch', { urls });
    expect(response.error ?? response.result?.isError).toBeTruthy();
  });
});
