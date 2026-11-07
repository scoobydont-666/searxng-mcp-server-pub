import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdmissionError, MemoryAdmissionStore, type AdmissionStore } from '../src/utils/admission.js';
import { safeFetch } from '../src/utils/fetch-client.js';
import { asFetchRequest, fixturePrincipal } from './fixtures.js';
import { digestToken } from '../src/middleware/auth.js';

afterEach(() => vi.restoreAllMocks());

const otherPrincipal = { ...fixturePrincipal, id: 'fixture-other' };
const publicUrl = 'https://93.184.216.34/page';

function okFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok', { headers: { 'content-type': 'text/plain' } }));
}

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

describe('per-principal and shared outbound fetch quota', () => {
  it('rejects a principal past its fetch budget before any outbound request', async () => {
    const fetch = okFetch();
    const store = new MemoryAdmissionStore();
    const config = { fetchPrincipalRate: 2, fetchSharedRate: 100 };
    (await asFetchRequest(() => safeFetch(publicUrl), store, config)).release();
    (await asFetchRequest(() => safeFetch(publicUrl), store, config)).release();
    const error = await outcome(() => asFetchRequest(() => safeFetch(publicUrl), store, config));
    expect(error).toBeInstanceOf(AdmissionError);
    expect(error).toMatchObject({ status: 429, code: 'fetch_rate_limit_exceeded' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not let one principal drain another principal allowance', async () => {
    const fetch = okFetch();
    const store = new MemoryAdmissionStore();
    const config = { fetchPrincipalRate: 1, fetchSharedRate: 100 };
    (await asFetchRequest(() => safeFetch(publicUrl), store, config)).release();
    await expect(asFetchRequest(() => safeFetch(publicUrl), store, config)).rejects.toThrow('fetch_rate_limit_exceeded');
    (await asFetchRequest(() => safeFetch(publicUrl), store, config, otherPrincipal)).release();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('bounds the deployment-wide fetch key across principals', async () => {
    const fetch = okFetch();
    const store = new MemoryAdmissionStore();
    const config = { fetchPrincipalRate: 100, fetchSharedRate: 1 };
    (await asFetchRequest(() => safeFetch(publicUrl), store, config)).release();
    const error = await outcome(() => asFetchRequest(() => safeFetch(publicUrl), store, config, otherPrincipal));
    expect(error).toMatchObject({ status: 429, code: 'fetch_capacity_exhausted' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails closed with 503 when the shared store is unavailable', async () => {
    const fetch = okFetch();
    const failing: AdmissionStore = {
      take: async () => { throw new AdmissionError(503, 'quota_store_unavailable'); },
      ready: async () => false,
      close: async () => undefined,
    };
    const error = await outcome(() => asFetchRequest(() => safeFetch(publicUrl), failing));
    expect(error).toMatchObject({ status: 503, code: 'quota_store_unavailable' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses to fetch outside a request admission context', async () => {
    const fetch = okFetch();
    await expect(safeFetch(publicUrl)).rejects.toThrow(/admission context/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keys principal budgets by identity, never by the token digest', async () => {
    okFetch();
    const seen: string[] = [];
    const recording: AdmissionStore = {
      take: async (key) => { seen.push(key); return true; },
      ready: async () => true,
      close: async () => undefined,
    };
    (await asFetchRequest(() => safeFetch(publicUrl), recording, {})).release();
    expect(seen).toEqual(['searxng-mcp:fetch:principal:fixture-fetch', 'searxng-mcp:fetch:shared']);
    expect(seen.join(' ')).not.toContain(digestToken('x'));
  });
});
