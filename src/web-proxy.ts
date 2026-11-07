import express, { type Request, type Response } from 'express';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import type { Config } from './constants.js';
import { AdmissionError, type AdmissionStore } from './utils/admission.js';
import { enginePlan, rejectQueryOverrides, requireEnginePolicy } from './utils/engine-policy.js';

export interface WebConfig {
  upstreamUrl: string;
  publicOrigin: string;
  port: number;
  maxResponseBytes: number;
  userRateLimit: number;
  userRateLimitWindowSeconds: number;
}

/** These are UI preferences only. OAuth cookies and private-engine tokens never pass. */
export const PREFERENCE_COOKIES = new Set([
  'categories', 'language', 'locale', 'method', 'safesearch', 'theme',
  'results_on_new_tab', 'doi_resolver', 'simple_style', 'center_alignment',
  'query_in_title', 'search_on_category_select', 'disabled_engines', 'enabled_engines',
  'disabled_plugins', 'enabled_plugins', 'hotkeys', 'url_formatting',
]);
const DOCUMENTS = new Set(['/', '/search', '/preferences', '/about']);
const UI_ASSETS = new Set(['/favicon.ico', '/manifest.json', '/opensearch.xml', '/robots.txt', '/engine_descriptions.json']);
const BODY_LIMIT = 65536;

function origin(value: string | undefined, name: string, httpsOnly = false): string {
  try {
    const url = new URL(value ?? '');
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(httpsOnly ? ['https:'] : ['http:', 'https:']).includes(url.protocol)) throw new Error();
    return url.origin;
  } catch { throw new Error(`${name} must be a fixed ${httpsOnly ? 'HTTPS' : 'HTTP(S)'} origin without credentials`); }
}

export function readWebConfig(cfg: Config, env: NodeJS.ProcessEnv = process.env): WebConfig {
  if (!cfg.redisUrl) throw new Error('The web gateway requires SEARXNG_MCP_REDIS_URL');
  requireEnginePolicy(cfg.enginePolicy);
  const port = Number(env.SEARXNG_WEB_PORT ?? '8088');
  const maxResponseBytes = Number(env.SEARXNG_WEB_MAX_RESPONSE_BYTES ?? String(8 * 1024 * 1024));
  const userRateLimit = Number(env.SEARXNG_WEB_USER_RATE_LIMIT ?? '60');
  const userRateLimitWindowSeconds = Number(env.SEARXNG_WEB_USER_RATE_LIMIT_WINDOW ?? '60');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SEARXNG_WEB_PORT');
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 64 * 1024 * 1024) {
    throw new Error('Invalid SEARXNG_WEB_MAX_RESPONSE_BYTES');
  }
  if (!Number.isInteger(userRateLimit) || userRateLimit < 1 || userRateLimit > 1000000) throw new Error('Invalid SEARXNG_WEB_USER_RATE_LIMIT');
  if (!Number.isInteger(userRateLimitWindowSeconds) || userRateLimitWindowSeconds < 1 || userRateLimitWindowSeconds > 3600) throw new Error('Invalid SEARXNG_WEB_USER_RATE_LIMIT_WINDOW');
  return {
    upstreamUrl: origin(env.SEARXNG_WEB_UPSTREAM_URL, 'SEARXNG_WEB_UPSTREAM_URL'),
    publicOrigin: origin(env.SEARXNG_WEB_PUBLIC_ORIGIN, 'SEARXNG_WEB_PUBLIC_ORIGIN', true),
    port, maxResponseBytes, userRateLimit, userRateLimitWindowSeconds,
  };
}

class ProxyError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function routeType(path: string): 'document' | 'asset' | null {
  // Reject ambiguous encodings and traversal before URL normalization or upstream dispatch.
  if (path.length > 2048 || /[%\\\x00-\x20]/.test(path) || path.includes('//') ||
    path.split('/').some(segment => segment === '.' || segment === '..')) return null;
  if (DOCUMENTS.has(path) || /^\/info\/[A-Za-z_-]{2,16}\/[A-Za-z0-9_-]{1,96}$/.test(path)) return 'document';
  if (UI_ASSETS.has(path) || /^\/static\/[A-Za-z0-9_./-]+\.(?:css|js|woff2?|ttf|otf|svg|png|jpe?g|gif|ico|webp|avif)$/.test(path)) return 'asset';
  return null;
}

function validateParameters(params: URLSearchParams): void {
  let count = 0;
  for (const [name, value] of params) {
    if (++count > 128 || name.length > 128 || value.length > 8192) throw new ProxyError(400, 'invalid_parameters');
    if (name === 'format' && value !== 'html') throw new ProxyError(400, 'html_only');
    if (name === 'q') {
      if (value.length > 2048) throw new ProxyError(400, 'invalid_query');
      rejectQueryOverrides(value);
    }
  }
}

const SEARCH_PREFERENCE_OVERRIDES = new Set(['categories', 'enabled_engines', 'disabled_engines', 'enabled_plugins', 'disabled_plugins', 'preferences', 'tokens', 'timeout_limit']);

function preferenceCookies(header: string | undefined, search = false): string | undefined {
  if (!header) return undefined;
  const selected = new Map<string, string>();
  for (const item of header.split(';')) {
    const split = item.indexOf('=');
    if (split <= 0) continue;
    const name = item.slice(0, split).trim(), value = item.slice(split + 1).trim();
    if (PREFERENCE_COOKIES.has(name) && !(search && SEARCH_PREFERENCE_OVERRIDES.has(name)) && !selected.has(name) && value.length <= 2048 && /^[\x21-\x7e]*$/.test(value) && !value.includes('\\')) {
      selected.set(name, value);
    }
  }
  return selected.size ? [...selected].map(([name, value]) => `${name}=${value}`).join('; ') : undefined;
}

function responseCookies(headers: Headers): string[] {
  return headers.getSetCookie().flatMap(cookie => {
    const parts = cookie.split(';'), pair = parts.shift() ?? '', split = pair.indexOf('=');
    const name = pair.slice(0, split).trim();
    if (split <= 0 || !PREFERENCE_COOKIES.has(name) || pair.length > 4096 || /[\r\n]/.test(cookie)) return [];
    const lifetime = parts.map(part => part.trim()).filter(part =>
      /^Max-Age=-?\d+$/i.test(part) || /^Expires=[A-Za-z0-9, :+-]+$/i.test(part));
    // Host-only cookies cannot reach sibling applications or replace OAuth session cookies.
    return [[pair, ...lifetime, 'Path=/', 'Secure', 'SameSite=Lax'].join('; ')];
  });
}

function redirectPath(location: string, web: WebConfig): string {
  if (/[\\\x00-\x20]/.test(location)) throw new ProxyError(502, 'invalid_upstream_redirect');
  let target: URL;
  try { target = new URL(location, web.upstreamUrl); } catch { throw new ProxyError(502, 'invalid_upstream_redirect'); }
  if (![web.upstreamUrl, web.publicOrigin].includes(target.origin) || target.username || target.password ||
    !routeType(target.pathname) || target.href.length > 8192) throw new ProxyError(502, 'invalid_upstream_redirect');
  validateParameters(target.searchParams);
  return target.pathname + target.search + target.hash;
}

function fail(res: Response, status: number, code: string): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) res.destroy();
  else res.status(status).json({ error: code });
}

/** Auth is supplied by OAuth2 proxy and enforced by the deployment's NetworkPolicy. */
export function createWebApplication(cfg: Config, web: WebConfig, store: AdmissionStore) {
  requireEnginePolicy(cfg.enginePolicy);
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', false);
  let draining = false, inflight = 0;

  app.get('/health', (_req, res) => res.json({ status: 'alive' }));
  app.get('/ready', async (_req, res) => {
    if (draining) { res.status(503).json({ ready: false }); return; }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const expired = new Promise<boolean>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(false); }, 3000);
      });
      const probes = Promise.all([
        fetch(new URL('/healthz', web.upstreamUrl), { signal: controller.signal, redirect: 'error' }).then(async result => {
          await result.body?.cancel(); return result.ok;
        }),
        store.ready(),
      ]).then(results => results.every(Boolean));
      const ready = await Promise.race([probes, expired]);
      res.status(ready ? 200 : 503).json({ ready });
    } catch { res.status(503).json({ ready: false }); }
    finally { clearTimeout(timer); controller.abort(); }
  });

  app.use((req, res, next) => {
    const path = req.url.split('?')[0], type = routeType(path);
    if (!type) { res.status(404).json({ error: 'not_found' }); return; }
    const methods = type === 'asset' ? ['GET', 'HEAD'] : ['GET', ...(path === '/' || path === '/search' || path === '/preferences' ? ['POST'] : [])];
    if (!methods.includes(req.method)) { res.set('Allow', methods.join(', ')); res.status(405).json({ error: 'method_not_allowed' }); return; }
    // OAuth2 proxy strips incoming identity variants and overwrites this header from its
    // verified session (pass-user-headers=true, skip-auth-strip-headers=true). NetworkPolicy
    // permits only that proxy to reach this port. Identity is never sent to SearXNG or logged.
    const identity = req.headers['x-forwarded-user'];
    const identityHeaders = req.rawHeaders.filter((_value, index) => index % 2 === 0).filter(name => name.toLowerCase().replaceAll('_', '-') === 'x-forwarded-user');
    if (typeof identity !== 'string' || !identity.trim() || identity.length > 512 || /[\x00-\x1f\x7f,]/.test(identity) || identityHeaders.length !== 1) {
      res.status(401).json({ error: 'authenticated_proxy_identity_required' }); return;
    }
    res.locals.userDigest = createHash('sha256').update(identity).digest('hex');
    if (req.url.length > Math.min(cfg.requestMaxBytes, 8192)) { res.status(414).json({ error: 'request_target_too_long' }); return; }
    if (draining || inflight >= cfg.maxInflight) { res.set('Retry-After', '1'); res.status(503).json({ error: draining ? 'draining' : 'overloaded' }); return; }
    if (req.method === 'POST' && (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded' || req.headers['content-encoding'])) {
      res.status(415).json({ error: 'form_body_required' }); return;
    }
    if (req.method !== 'POST' && (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) > 0)) {
      res.status(400).json({ error: 'unexpected_body' }); return;
    }
    inflight++;
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); fail(res, 504, 'request_timeout'); }, cfg.requestTimeoutMs);
    let released = false;
    const release = () => {
      if (released) return;
      released = true; clearTimeout(timer); controller.abort(); inflight--;
    };
    res.once('finish', release); res.once('close', release);
    res.locals.signal = controller.signal;
    res.locals.routeType = type;
    next();
  });
  app.use(express.raw({ type: () => true, limit: Math.min(cfg.requestMaxBytes, BODY_LIMIT), inflate: false }));

  app.use(async (req, res) => {
    const signal = res.locals.signal as AbortSignal;
    try {
      const target = new URL(req.url, web.upstreamUrl);
      const body = req.method === 'POST' ? new URLSearchParams((req.body as Buffer | undefined)?.toString('utf8') ?? '') : undefined;
      validateParameters(target.searchParams);
      if (body) validateParameters(body);
      const search = target.pathname === '/search' || target.pathname === '/' && (req.method === 'POST' || target.searchParams.has('q'));
      let pools: string[][] = [[]];
      if (search) {
        const input = body ?? target.searchParams;
        let category = input.get('categories') ?? target.searchParams.get('categories');
        if (!category) {
          const flags = [...input].filter(([name, value]) => name.startsWith('category_') && !['0', 'false', 'off'].includes(value)).map(([name]) => name.slice(9));
          if (flags.length > 1) throw new ProxyError(400, 'one_category_required');
          category = flags[0] ?? 'general';
        }
        if (input.getAll('engines').length > 1 || target.searchParams.getAll('engines').length > 1) throw new ProxyError(400, 'engine_not_allowed');
        const explicit = input.get('engines') ?? target.searchParams.get('engines') ?? undefined;
        pools = enginePlan(cfg.enginePolicy, category, explicit);
        for (const params of [target.searchParams, ...(body ? [body] : [])]) {
          for (const key of [...params.keys()]) {
            if (key.startsWith('category_') || SEARCH_PREFERENCE_OVERRIDES.has(key)) params.delete(key);
          }
          // Never forward category selectors: SearXNG would append their whole inventory.
          params.delete('categories');
          params.set('format', 'html');
        }
        // Normalize root aliases without an extra redirect or search admission.
        target.pathname = '/search';
        let userAdmitted: boolean;
        try { userAdmitted = await store.take(`${cfg.rateLimitPrefix}:web-user:${res.locals.userDigest as string}`, web.userRateLimit, web.userRateLimitWindowSeconds * 1000); }
        catch { throw new ProxyError(503, 'quota_store_unavailable'); }
        signal.throwIfAborted();
        if (!userAdmitted) { res.set('Retry-After', String(web.userRateLimitWindowSeconds)); throw new ProxyError(429, 'user_rate_limit_exceeded'); }
      }
      const headers = new Headers({ Accept: res.locals.routeType === 'document' ? 'text/html' : '*/*', 'User-Agent': cfg.userAgent });
      const cookies = preferenceCookies(req.headers.cookie, search);
      if (cookies) headers.set('Cookie', cookies);
      if (body) headers.set('Content-Type', 'application/x-www-form-urlencoded');
      if (res.locals.routeType === 'asset') {
        for (const name of ['if-none-match', 'if-modified-since']) {
          const value = req.headers[name]; if (typeof value === 'string' && value.length <= 1024) headers.set(name, value);
        }
      }
      // This newly constructed header set excludes Authorization, forwarding and identity headers.
      let upstream: globalThis.Response | undefined;
      let usedPool = 0;
      for (const [attempt, engines] of pools.entries()) {
        if (search) {
          let admitted: boolean;
          try { admitted = await store.take(`${cfg.rateLimitPrefix}:search`, cfg.searchRate, 1000); }
          catch { throw new ProxyError(503, 'quota_store_unavailable'); }
          signal.throwIfAborted();
          if (!admitted) { res.set('Retry-After', '1'); throw new ProxyError(429, 'search_rate_limit_exceeded'); }
          target.searchParams.set('engines', engines.join(','));
          body?.set('engines', engines.join(','));
        }
        const attemptController = new AbortController();
        const attemptTimer = search ? setTimeout(() => attemptController.abort(), cfg.searchTimeoutMs) : undefined;
        try {
          upstream = await fetch(target, { method: req.method, headers, body: body?.toString(), signal: AbortSignal.any([signal, attemptController.signal]), redirect: 'manual' });
          usedPool = attempt;
          if (search && [403, 429, 503].includes(upstream.status) && attempt + 1 < pools.length) {
            await upstream.body?.cancel(); upstream = undefined; continue;
          }
          break;
        } catch (error) {
          if (!signal.aborted && attemptController.signal.aborted && attempt + 1 < pools.length) continue;
          throw error;
        } finally { clearTimeout(attemptTimer); }
      }
      if (!upstream) throw new ProxyError(502, 'web_upstream_unavailable');
      if (search) {
        res.set('X-SearXNG-Fallback', String(usedPool > 0));
        res.set('X-SearXNG-Attempts', String(usedPool + 1));
        res.set('X-SearXNG-Engines', pools[usedPool].join(','));
      }
      const cookieHeaders = responseCookies(upstream.headers);
      if (cookieHeaders.length) res.setHeader('Set-Cookie', cookieHeaders);
      res.set('Cache-Control', res.locals.routeType === 'asset' ? upstream.headers.get('cache-control') ?? 'public, max-age=3600' : 'private, no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Referrer-Policy', 'no-referrer');
      res.set('X-Frame-Options', 'DENY');
      if (upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304) {
        const location = upstream.headers.get('location');
        await upstream.body?.cancel();
        if (!location) throw new ProxyError(502, 'invalid_upstream_redirect');
        res.status(upstream.status).set('Location', redirectPath(location, web)).end();
        return;
      }
      const contentType = upstream.headers.get('content-type') ?? '';
      if (res.locals.routeType === 'document' && upstream.status !== 204 && !/^text\/html(?:;|$)/i.test(contentType)) {
        await upstream.body?.cancel(); throw new ProxyError(502, 'invalid_upstream_content');
      }
      if (Number(upstream.headers.get('content-length')) > web.maxResponseBytes) {
        await upstream.body?.cancel(); throw new ProxyError(502, 'upstream_response_too_large');
      }
      for (const name of ['content-type', 'content-security-policy', 'etag', 'last-modified']) {
        const value = upstream.headers.get(name); if (value) res.setHeader(name, value);
      }
      // fetch decompresses response bodies; do not copy Content-Encoding or Content-Length.
      res.status(upstream.status);
      const reader = upstream.body?.getReader();
      if (!reader) { res.end(); return; }
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > web.maxResponseBytes) throw new ProxyError(502, 'upstream_response_too_large');
          if (!res.write(value)) await once(res, 'drain', { signal });
        }
        res.end();
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    } catch (error) {
      if (signal.aborted) fail(res, 504, 'request_timeout');
      else if (error instanceof ProxyError || error instanceof AdmissionError) fail(res, error.status, error.code);
      else fail(res, 502, 'web_upstream_unavailable');
    }
  });
  app.use((error: { status?: number }, _req: Request, res: Response, _next: express.NextFunction) => {
    fail(res, error.status === 413 ? 413 : 400, error.status === 413 ? 'request_too_large' : 'invalid_request');
  });
  return { app, drain: () => { draining = true; }, activeRequests: () => inflight };
}
