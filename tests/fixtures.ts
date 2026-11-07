import type { EnginePolicy } from '../src/utils/engine-policy.js';

export const fixtureEnginePolicy: EnginePolicy = {
  engines: ['fixture-primary', 'fixture-fallback'],
  categories: {
    general: { primary: ['fixture-primary'], fallbacks: [['fixture-fallback']] },
    news: { primary: ['fixture-primary'], fallbacks: [['fixture-fallback']] },
    images: { primary: ['fixture-primary'], fallbacks: [['fixture-fallback']] },
    videos: { primary: ['fixture-primary'], fallbacks: [['fixture-fallback']] },
    science: { primary: ['fixture-primary'], fallbacks: [['fixture-fallback']] },
  },
};

import {MemoryAdmissionStore, type AdmissionStore} from '../src/utils/admission.js';
import {readConfig, type Config} from '../src/constants.js';
import type {Principal} from '../src/middleware/auth.js';

export const fixturePrincipal: Principal = {
  id: 'fixture-fetch', token_sha256: '0'.repeat(64), scopes: ['mcp:fetch'], rate_limit: 1000,
};

/**
 * Runs fetch-path code as a request would: principal, quota store, config and abort signal are all present.
 * The request-context module is imported at call time so tests that reset modules use the same instance.
 */
export async function asFetchRequest<T>(fn: () => Promise<T>, store: AdmissionStore = new MemoryAdmissionStore(),
  config: Partial<Config> = {}, principal: Principal = fixturePrincipal): Promise<T> {
  const {requestContext} = await import('../src/utils/request-context.js');
  return requestContext.run({
    signal: new AbortController().signal, store, config: {...readConfig({}), ...config}, principal,
  }, fn);
}
