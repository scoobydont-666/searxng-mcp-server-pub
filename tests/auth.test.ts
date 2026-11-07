import { describe, it, expect, vi } from 'vitest';

// ── auth middleware unit tests ──────────────────────────────────────────────

import { createAuthMiddleware, loadPrincipals } from '../src/middleware/auth.js';
import { readConfig } from '../src/constants.js';
import type { Request, Response, NextFunction } from 'express';

function makeReq(headers: Record<string, string> = {}): Partial<Request> {
  return { headers, method: 'POST', path: '/mcp' } as Partial<Request>;
}

function makeRes(): { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; statusCode?: number } {
  const res: Record<string, unknown> = {};
  res.json = vi.fn().mockReturnValue(res);
  res.status = vi.fn().mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  return res as ReturnType<typeof makeRes>;
}

describe('createAuthMiddleware', () => {
  const TOKEN = 'test-secret-token-abc123';

  it('rejects request with no Authorization header → 401', () => {
    const mw = createAuthMiddleware({
      token: TOKEN,
      authRequired: true,
      allowedOrigins: [],
      rateLimit: 1000,
      rateLimitWindowSeconds: 60,
      onReject: vi.fn(),
    });
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();
    mw(req as Request, res as unknown as Response, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects request with wrong token → 401', () => {
    const mw = createAuthMiddleware({
      token: TOKEN,
      authRequired: true,
      allowedOrigins: [],
      rateLimit: 1000,
      rateLimitWindowSeconds: 60,
      onReject: vi.fn(),
    });
    const req = makeReq({ authorization: 'Bearer wrong-token' });
    const res = makeRes();
    const next = vi.fn();
    mw(req as Request, res as unknown as Response, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('admits request with correct Bearer token → calls next()', () => {
    const mw = createAuthMiddleware({
      token: TOKEN,
      authRequired: true,
      allowedOrigins: [],
      rateLimit: 1000,
      rateLimitWindowSeconds: 60,
      onReject: vi.fn(),
    });
    const req = makeReq({ authorization: `Bearer ${TOKEN}` });
    const res = makeRes();
    const next = vi.fn();
    mw(req as Request, res as unknown as Response, next as NextFunction);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('Startup credential loading', () => {
  it('refuses startup without a manifest or legacy token', () => {
    expect(() => loadPrincipals(readConfig({}))).toThrow(/Authentication required/);
  });

  it('accepts an explicitly configured legacy credential during migration', () => {
    const principals = loadPrincipals(readConfig({SEARXNG_MCP_TOKEN:'fixture-only-legacy-token'}));
    expect(principals).toHaveLength(1);
    expect(principals[0].id).toBe('legacy');
    expect(principals[0].token_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses an unreadable manifest even when a legacy credential is present', () => {
    expect(() => loadPrincipals(readConfig({SEARXNG_MCP_TOKEN:'fixture-only-legacy-token',
      SEARXNG_MCP_PRINCIPALS_FILE:'/nonexistent-public-test-fixture/principals.json'}))).toThrow(/Invalid or unreadable/);
  });
});
