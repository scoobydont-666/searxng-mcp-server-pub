import { config } from '../constants.js';
import { sleepWithJitter, parseRetryAfter } from './backoff.js';
import { isAlternativeContent, loadFeedPolicy, resolveAlternatives, type AlternativeProvenance } from './feed-fallback.js';
import { publicOnlyDispatcher, validateFetchUrl } from './public-network.js';
import { AdmissionError } from './admission.js';
import { ByteBudget } from './byte-budget.js';
import { KeyLimiter } from './key-limiter.js';
import { principalDigest, requestContext } from './request-context.js';

const feedPolicy = loadFeedPolicy();

/**
 * Server-side log only. Never includes paths, queries, bodies or tokens; debug lines are emitted only at debug level.
 */
function log(level: 'debug' | 'info' | 'warn', msg: string, data?: Record<string, unknown>): void {
  if (level === 'debug' && config.logLevel !== 'debug') return;
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data }) + '\n');
}

/**
 * The only fetch failure text a caller sees. The specific reason is logged server-side, so a caller cannot
 * use error text to learn how DNS, allowlist or address policy treated a name.
 */
export class FetchFailure extends Error {
  constructor(readonly reason: string) {
    super('fetch_failed');
    this.name = 'FetchFailure';
  }
}

function principalField(): { principal?: string } {
  const principal = requestContext.getStore()?.principal;
  return principal ? { principal: principalDigest(principal.id) } : {};
}

/**
 * Each outbound request (including retries and alternative-source requests) consumes two fixed-window
 * tokens in the shared store: one for the principal and one for the whole deployment. Store failures
 * propagate as 503 through AdmissionError, so the fetch fails closed.
 */
async function chargeOutboundFetch(): Promise<void> {
  const context = requestContext.getStore();
  if (!context) throw new Error('outbound fetch requires request admission context');
  const windowMs = context.config.rateLimitWindowSeconds * 1000;
  const prefix = context.config.rateLimitPrefix;
  if (!await context.store.take(`${prefix}:fetch:principal:${context.principal.id}`, context.config.fetchPrincipalRate, windowMs)) {
    throw new AdmissionError(429, 'fetch_rate_limit_exceeded');
  }
  if (!await context.store.take(`${prefix}:fetch:shared`, context.config.fetchSharedRate, windowMs)) {
    throw new AdmissionError(429, 'fetch_capacity_exhausted');
  }
}

function denied(reason: string, data: Record<string, unknown> = {}): FetchFailure {
  log('warn', 'fetch denied', { reason, ...principalField(), ...data });
  return new FetchFailure(reason);
}

/** Bounded, content-free classification of an error chain (for example ENOTFOUND or EACCES). */
function errorCode(err: unknown): string {
  if (err instanceof FetchFailure) return err.reason;
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return 'network_error';
}

export function isDomainAllowed(requestedHost: string, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return true;
  const target = requestedHost.toLowerCase();
  return allowedDomains.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p.startsWith('*.')) {
      const suffix = p.slice(1);
      return target.endsWith(suffix) && target.length > suffix.length;
    }
    return target === p;
  });
}

export interface FetchResult {
  status: number;
  url_final: string;
  content_type: string;
  body: ArrayBuffer;
  truncated: boolean;
  bytes: number;
  elapsed_ms: number;
  alternative?: AlternativeProvenance;
  /** Returns the buffer reservation. Callers must call it once they have finished with `body`. */
  release: () => void;
}

export interface FetchOptions {
  /** Override default timeout. */
  timeout_ms?: number;
  /** Cap response bytes — content longer is truncated and `truncated: true` is set. */
  max_bytes?: number;
  /** Compatibility parameter; must match the configured transparent User-Agent. */
  user_agent?: string;
  /** Extra headers (e.g. Accept). */
  headers?: Record<string, string>;
  /** HTTP method. Default GET. */
  method?: string;
}

// ---- Per-host concurrency cap (mutex per origin) ----
async function acquireHost(host: string, concurrency: number): Promise<() => void> {
  let inFlight = (hostInFlight.get(host) ?? 0);
  while (inFlight >= concurrency) {
    requestContext.getStore()?.signal.throwIfAborted();
    await new Promise((r) => setTimeout(r, 25));
    inFlight = (hostInFlight.get(host) ?? 0);
  }
  hostInFlight.set(host, inFlight + 1);
  return () => {
    const cur = hostInFlight.get(host) ?? 1;
    if (cur <= 1) hostInFlight.delete(host);
    else hostInFlight.set(host, cur - 1);
  };
}
const hostInFlight = new Map<string, number>();

// ---- Process-local token-bucket rate limiter (not a cluster-wide quota) ----
class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();
  constructor(private readonly capacity: number, private readonly refillPerSec: number) {
    this.tokens = capacity;
  }
  async take(): Promise<void> {
    while (true) {
      requestContext.getStore()?.signal.throwIfAborted();
      const now = Date.now();
      const elapsed = (now - this.lastRefill) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
      this.lastRefill = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.min(100,Math.max(25, ((1 - this.tokens) / this.refillPerSec) * 1000));
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
const processBucket = new TokenBucket(config.fetchGlobalRateLimit * 2, config.fetchGlobalRateLimit);

/** Process-wide cap on buffered body bytes; each body holds its reservation until the caller releases it. */
export const bufferBudget = new ByteBudget(config.fetchBufferBytes);
const principalReservations = new KeyLimiter(config.fetchPrincipalConcurrency);
const BLOCK_PREVIEW_BYTES = 64 * 1024;

type ResizableArrayBuffer = ArrayBuffer & { resize(length: number): void };
/** Grows to the exact body length without a second copy; the reservation already covers the cap. */
function newResizableBuffer(cap: number): ResizableArrayBuffer {
  const Constructor = ArrayBuffer as unknown as new (length: number, options: { maxByteLength: number }) => ResizableArrayBuffer;
  return new Constructor(0, { maxByteLength: cap });
}

/**
 * Fetch a URL with retry/backoff, per-host concurrency cap, and process-local rate limit.
 * Returns body as ArrayBuffer plus metadata. Caller decodes per content-type.
 */
export async function safeFetch(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  if (opts.user_agent && opts.user_agent !== config.userAgent) {
    throw new Error('User-Agent is controlled by server configuration');
  }
  const primary = await fetchOnce(url, opts, config.userAgent);
  if (opts.method && opts.method !== 'GET') return primary;
  try {
    const alternatives = resolveAlternatives(feedPolicy, url, primary.status);
    if (alternatives.length > 0) {
      // A fallback needs the same principal permit and byte budget as its predecessor.
      // Discard the blocked body before returning those resources; keep only status metadata
      // if every alternative fails. Retaining an unaccounted preview would defeat the cap.
      primary.truncated ||= primary.bytes > 0;
      primary.body = new ArrayBuffer(0);
      primary.bytes = 0;
      primary.release();
    }
    for (const source of alternatives) {
      requestContext.getStore()?.signal.throwIfAborted();
      // No original cookies, Authorization, identity, Referer or arbitrary caller
      // headers cross into a publisher's alternative public feed/API.
      try {
        const alternate = await fetchOnce(source.url, {
          timeout_ms: opts.timeout_ms, max_bytes: opts.max_bytes, method:'GET',
          headers:{Accept:source.kind === 'api' ? 'application/json, application/atom+xml, application/xml;q=0.9' : 'application/atom+xml, application/rss+xml, application/xml;q=0.9'},
        }, config.userAgent);
        let accepted = false;
        try {
          accepted = alternate.status >= 200 && alternate.status < 300 && !alternate.truncated &&
            new URL(alternate.url_final).origin === new URL(source.url).origin &&
            await isAlternativeContent(source.kind, alternate.content_type, alternate.body);
        } finally {
          if (!accepted) alternate.release();
        }
        if (accepted) {
          primary.release();
          return {...alternate,alternative:{...source,original_url:url,original_status:primary.status,semantics:'alternative_source_not_original_page'}};
        }
      } catch (err) {
        requestContext.getStore()?.signal.throwIfAborted();
        if (err instanceof AdmissionError) throw err;
        log('warn','Alternative public source unavailable',{rule:source.rule});
      }
    }
    return primary;
  } catch (err) {
    primary.release();
    throw err;
  }
}

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'www-authenticate',
]);

function stripSensitiveHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!SENSITIVE_HEADERS.has(k.toLowerCase())) {
      out[k] = v;
    }
  }
  return out;
}

/** Combines signals without leaving a listener on the long-lived one after dispose. */
function linkSignals(own: AbortSignal, parent?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  if (!parent) return { signal: own, dispose: () => undefined };
  const combined = new AbortController();
  const abort = (from: AbortSignal) => () => combined.abort(from.reason);
  const onOwn = abort(own);
  const onParent = abort(parent);
  const dispose = (): void => {
    own.removeEventListener('abort', onOwn);
    parent.removeEventListener('abort', onParent);
  };
  if (own.aborted) combined.abort(own.reason);
  else if (parent.aborted) combined.abort(parent.reason);
  else {
    own.addEventListener('abort', onOwn, { once: true });
    parent.addEventListener('abort', onParent, { once: true });
  }
  return { signal: combined.signal, dispose };
}

async function fetchOnce(
  url: string,
  opts: FetchOptions,
  ua: string,
  hops: number = 0,
): Promise<FetchResult> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw denied('invalid_url');
  }
  try {
    validateFetchUrl(u);
  } catch (err) {
    throw denied(err instanceof Error ? err.message : 'destination_policy');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw denied('unsupported_scheme');

  if (!isDomainAllowed(u.hostname, config.allowedDomains)) {
    throw denied('domain_not_allowed', { host: u.hostname });
  }

  log('debug', 'fetch', { host: u.hostname, method: opts.method ?? 'GET', ...principalField() });

  const context = requestContext.getStore();
  context?.signal.throwIfAborted();
  const timeout = Math.min(opts.timeout_ms ?? config.fetchTimeoutMs, config.fetchTimeoutMs);
  const maxBytes = Math.min(opts.max_bytes ?? config.fetchMaxBytes, config.fetchMaxBytes);
  const method = opts.method ?? 'GET';

  let redirectTo: string | null = null;
  const release = await acquireHost(u.hostname, config.fetchPerHostConcurrency);
  try {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= config.fetchRetries; attempt++) {
      await processBucket.take();
      await chargeOutboundFetch();
      const start = Date.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeout);
      const linked = linkSignals(ac.signal, context?.signal);
      try {
        context?.signal.throwIfAborted();
        const headers = new Headers(opts.headers);
        headers.set('User-Agent', ua);
        if (!headers.has('Accept')) headers.set('Accept', '*/*');
        const res = await fetch(url, {
          method,
          redirect: 'manual',
          headers,
          dispatcher: publicOnlyDispatcher,
          signal: linked.signal,
        } as RequestInit & {dispatcher: typeof publicOnlyDispatcher});


        if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
          redirectTo = new URL(res.headers.get('location') as string, url).toString();
          await res.body?.cancel();
          break;
        }

        // Blocking responses are returned to the caller for an explicit alternate-source policy.
        if (res.status >= 500 && res.status < 600 && res.status !== 503 && attempt < config.fetchRetries) {
          const ra = parseRetryAfter(res.headers.get('retry-after'));
          await res.body?.cancel();
          await sleepWithJitter(attempt, ra);
          lastErr = new Error(`HTTP ${res.status}`);
          continue;
        }

        // A large challenge must not prevent a configured alternative from being tried.
        // Preview blocking responses within the cap, then cancel the rest of their body.
        const blocking = feedPolicy !== null && feedPolicy.triggerStatuses.some(status => status === res.status);
        const cap = blocking ? Math.min(maxBytes, BLOCK_PREVIEW_BYTES) : maxBytes;
        const cl = Number(res.headers.get('content-length') ?? 0);
        if (cl > maxBytes && !blocking) {
          await res.body?.cancel();
          throw new FetchFailure('content_length_limit');
        }
        const reader = res.body?.getReader();
        if (!reader) {
          return {
            status: res.status,
            url_final: res.url || url,
            content_type: res.headers.get('content-type') ?? 'application/octet-stream',
            body: new ArrayBuffer(0),
            truncated: false,
            bytes: 0,
            elapsed_ms: Date.now() - start,
            release: () => undefined,
          };
        }
        // The reservation is taken only after headers, so redirects and rejected responses hold no budget.
        // A plain body with a valid Content-Length reserves only that length; an encoded body may expand, so it reserves the cap.
        const encoded = (res.headers.get('content-encoding') ?? 'identity').trim().toLowerCase() !== 'identity';
        const exact = !encoded && Number.isSafeInteger(cl) && cl > 0 && cl < cap;
        const reserved = exact ? cl : cap;
        const waitSignal = linked.signal;
        const releasePrincipal = await principalReservations.acquire(context?.principal.id ?? '', waitSignal);
        let releaseBytes: () => void;
        try {
          releaseBytes = await bufferBudget.acquire(reserved, waitSignal);
        } catch (err) {
          releasePrincipal();
          throw err;
        }
        const release = (): void => { releaseBytes(); releasePrincipal(); };
        try {
          const store = newResizableBuffer(reserved);
          let bytes = 0;
          let truncated = false;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            if (exact && bytes + value.byteLength > reserved) throw new FetchFailure('content_length_mismatch');
            const take = Math.min(value.byteLength, cap - bytes);
            store.resize(bytes + take);
            new Uint8Array(store).set(value.subarray(0, take), bytes);
            bytes += take;
            if (take < value.byteLength) {
              truncated = true;
              try { await reader.cancel(); } catch { /* ignore */ }
              break;
            }
          }
          return {
            status: res.status,
            url_final: res.url || url,
            content_type: res.headers.get('content-type') ?? 'application/octet-stream',
            body: store,
            truncated,
            bytes,
            elapsed_ms: Date.now() - start,
            release,
          };
        } catch (err) {
          release();
          throw err;
        }
      } catch (err) {
        if (context?.signal.aborted || ac.signal.aborted) throw err;
        if (err instanceof FetchFailure || err instanceof AdmissionError) throw err;
        lastErr = err;
        if (attempt < config.fetchRetries) {
          await sleepWithJitter(attempt);
        }
      } finally {
        clearTimeout(timer);
        linked.dispose();
      }
    }
    if (redirectTo === null) {
      log('warn', 'fetch failed', { reason: errorCode(lastErr), host: u.hostname, attempts: config.fetchRetries + 1, ...principalField() });
      throw new FetchFailure(errorCode(lastErr));
    }
  } finally {
    release();
  }
  if (hops >= 5) throw denied('redirect_limit');
  const nextUrl = new URL(redirectTo);
  if (u.protocol === 'https:' && nextUrl.protocol === 'http:') throw denied('redirect_downgrade');
  const nextOpts: FetchOptions =
    nextUrl.origin !== u.origin
      ? { ...opts, headers: stripSensitiveHeaders(opts.headers) }
      : opts;
  return fetchOnce(redirectTo, nextOpts, ua, hops + 1);
}

export function decodeBody(body: ArrayBuffer, contentType: string): string {
  // Default to utf-8; honor charset= when present.
  const m = /charset=([\w-]+)/i.exec(contentType);
  const enc = m?.[1]?.toLowerCase() ?? 'utf-8';
  try {
    return new TextDecoder(enc, { fatal: false }).decode(body);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(body);
  }
}
