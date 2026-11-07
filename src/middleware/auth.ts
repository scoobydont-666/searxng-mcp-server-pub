import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Request, Response, NextFunction } from 'express';
import type { Config } from '../constants.js';
import { z } from 'zod';

export const Scope = z.enum(['mcp:search', 'mcp:fetch', 'api:search']);
export type Scope = z.infer<typeof Scope>;
const PrincipalSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/),
  token_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  scopes: z.array(Scope).min(1).max(3),
  rate_limit: z.number().int().min(1).max(100000),
  expires_at: z.string().datetime().optional(),
}).strict();
export type Principal = z.infer<typeof PrincipalSchema>;
const ManifestSchema = z.object({ principals: z.array(PrincipalSchema).min(1).max(10000) }).strict();
export function parsePrincipals(input: unknown): Principal[] {
  const result = ManifestSchema.parse(input).principals;
  const ids = new Set<string>(), hashes = new Set<string>();
  for (const p of result) {
    if (ids.has(p.id) || hashes.has(p.token_sha256)) throw new Error('Duplicate principal id or token hash');
    ids.add(p.id); hashes.add(p.token_sha256);
  }
  return result;
}
export function loadPrincipals(cfg: Config): Principal[] {
  let principals: Principal[] = [];
  if (cfg.principalsFile) {
    try { principals = parsePrincipals(JSON.parse(readFileSync(cfg.principalsFile, 'utf8'))); }
    catch { throw new Error('Invalid or unreadable principal manifest'); }
  }
  if (cfg.authToken) {
    if (principals.some(p => p.id === 'legacy' || p.token_sha256 === digestToken(cfg.authToken!))) throw new Error('Duplicate legacy principal id or token hash');
    principals.push({id:'legacy', token_sha256: digestToken(cfg.authToken), scopes:['mcp:search','mcp:fetch','api:search'], rate_limit:cfg.rateLimit});
  }
  if (!principals.length) throw new Error('Authentication required: configure a principal manifest or SEARXNG_MCP_TOKEN');
  if (cfg.fetchEnabled && !cfg.allowedDomains.length) throw new Error('Fetch tools require a nonempty SEARXNG_MCP_ALLOWED_DOMAINS allowlist');
  return principals;
}
export function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
/** Build once at startup; authentication remains O(1) for thousands of principals. */
export function createAuthenticator(principals: Principal[]) {
  const byHash = new Map(principals.map(p => [p.token_sha256,p]));
  return (header: string | undefined, now = Date.now()): Principal | undefined => {
    if (!header?.startsWith('Bearer ') || header.length > 8192) return undefined;
    const token = header.slice(7);
    if (!token || /\s/.test(token)) return undefined;
    const digest = digestToken(token);
    const principal = byHash.get(digest);
    if (!principal || !timingSafeEqual(Buffer.from(digest,'hex'),Buffer.from(principal.token_sha256,'hex'))) return undefined;
    return !principal.expires_at || Date.parse(principal.expires_at) > now ? principal : undefined;
  };
}
export function authenticate(header: string | undefined, principals: Principal[], now = Date.now()): Principal | undefined {
  return createAuthenticator(principals)(header,now);
}

/** Compatibility adapter for callers importing the previous middleware. */
export interface AuthConfig {
  token: string | null; authRequired: boolean; allowedOrigins: string[];
  rateLimit: number; rateLimitWindowSeconds: number;
  onReject: (reason: 'unauth' | 'origin' | 'rate') => void;
}
export function createAuthMiddleware(cfg: AuthConfig) {
  const principal: Principal[] = cfg.token ? [{id:'legacy',token_sha256:digestToken(cfg.token),scopes:['mcp:search'],rate_limit:cfg.rateLimit}] : [];
  const authenticateRequest = createAuthenticator(principal);
  let start = Date.now(), count = 0;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.headers.origin && !cfg.allowedOrigins.includes(req.headers.origin)) {
      cfg.onReject('origin'); res.status(403).json({error:'Origin not allowed'}); return;
    }
    if (!authenticateRequest(req.headers.authorization)) {
      cfg.onReject('unauth'); res.status(401).json({error:'Authentication required'}); return;
    }
    if (Date.now() >= start + cfg.rateLimitWindowSeconds * 1000) { start = Date.now(); count = 0; }
    if (++count > cfg.rateLimit) {
      cfg.onReject('rate'); res.set('Retry-After',String(cfg.rateLimitWindowSeconds)); res.status(429).json({error:'Rate limit exceeded'}); return;
    }
    next();
  };
}
