import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { AdmissionStore } from './admission.js';
import type { Config } from '../constants.js';
import type { Principal } from '../middleware/auth.js';
export interface RequestContext { signal: AbortSignal; deadline?: number; store: AdmissionStore; config: Config; principal: Principal }
export const requestContext = new AsyncLocalStorage<RequestContext>();
/** Log-safe principal reference; the principal id is not secret, but it is still kept out of raw logs. */
export function principalDigest(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 16);
}
