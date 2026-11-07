import { loadEnginePolicy, type EnginePolicy } from './utils/engine-policy.js';

/** Runtime settings are validated once at startup; changes require a rollout. */
export interface Config {
  bindHost: string; port: number; adminBindHost: string; adminPort: number; searxngUrl: string; authToken: string | null;
  allowedOrigins: string[]; rateLimit: number; rateLimitWindowSeconds: number;
  fetchMaxBytes: number; fetchTimeoutMs: number; fetchPerHostConcurrency: number;
  fetchGlobalRateLimit: number; fetchRetries: number; userAgent: string;
  allowedDomains: string[];
  mcpEnabled: boolean; apiEnabled: boolean; fetchEnabled: boolean;
  principalsFile: string | null; redisUrl: string | null; rateLimitPrefix: string;
  searchRate: number; maxInflight: number; requestTimeoutMs: number;
  requestMaxBytes: number; shutdownGraceMs: number; searchMaxBytes: number;
  enginePolicyFile: string | null; enginePolicy: EnginePolicy | null; searchTimeoutMs: number;
  logLevel: 'info' | 'debug';
  fetchPrincipalRate: number; fetchSharedRate: number;
  fetchBufferBytes: number; fetchPrincipalConcurrency: number; htmlParseMaxChars: number; parseWorkers: number; parseHeapMb: number;
}
function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 1, max = 2147483647): number {
  const value = env[key];
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return n;
}
function boolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const value = env[key];
  if (value === undefined) return fallback;
  if (value !== 'true' && value !== 'false') throw new Error(`${key} must be true or false`);
  return value === 'true';
}
function list(value: string | undefined): string[] {
  return value?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
}
function logLevel(env: NodeJS.ProcessEnv): 'info' | 'debug' {
  const value = env.SEARXNG_MCP_LOG_LEVEL ?? 'info';
  if (value !== 'info' && value !== 'debug') throw new Error('SEARXNG_MCP_LOG_LEVEL must be info or debug');
  return value;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const searxngUrl = env.SEARXNG_URL ?? 'http://127.0.0.1:8080';
  const upstream = new URL(searxngUrl);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password) {
    throw new Error('SEARXNG_URL must be an HTTP(S) origin without credentials');
  }
  const enginePolicyFile = env.SEARXNG_MCP_ENGINE_POLICY_FILE || null;
  const userAgent = env.SEARXNG_MCP_USER_AGENT ?? 'SearXNG-MCP/0.2';
  if (!userAgent || userAgent.length > 512 || /[\r\n\x00-\x1f]/.test(userAgent)) throw new Error('Invalid SEARXNG_MCP_USER_AGENT');
  const allowedOrigins = list(env.SEARXNG_MCP_ALLOWED_ORIGINS);
  for (const origin of allowedOrigins) {
    if (!['http:', 'https:'].includes(new URL(origin).protocol) || new URL(origin).origin !== origin) throw new Error('Allowed origins must be exact HTTP(S) origins');
  }
  const port = integer(env, 'SEARXNG_MCP_PORT', 8527, 1, 65535);
  const adminPort = integer(env, 'SEARXNG_MCP_ADMIN_PORT', 8528, 1, 65535);
  const fetchMaxBytes = integer(env, 'SEARXNG_MCP_FETCH_MAX_BYTES', 8 * 1024 * 1024, 1, 64 * 1024 * 1024);
  const fetchBufferBytes = integer(env, 'SEARXNG_MCP_FETCH_BUFFER_BYTES', 64 * 1024 * 1024, 1, 1024 * 1024 * 1024);
  // Every fetch reserves its full byte cap, so the budget must admit at least one maximum-size body.
  if (fetchBufferBytes < fetchMaxBytes) throw new Error('SEARXNG_MCP_FETCH_BUFFER_BYTES must be at least SEARXNG_MCP_FETCH_MAX_BYTES');
  if (adminPort === port) throw new Error('SEARXNG_MCP_ADMIN_PORT must differ from SEARXNG_MCP_PORT');
  return Object.freeze({
    bindHost: env.SEARXNG_MCP_BIND_HOST ?? '0.0.0.0',
    port, searxngUrl,
    adminBindHost: env.SEARXNG_MCP_ADMIN_BIND_HOST ?? '127.0.0.1',
    adminPort,
    authToken: env.SEARXNG_MCP_TOKEN?.trim() || null, allowedOrigins,
    rateLimit: integer(env, 'SEARXNG_MCP_RATE_LIMIT', 600),
    rateLimitWindowSeconds: integer(env, 'SEARXNG_MCP_RATE_LIMIT_WINDOW', 60, 1, 3600),
    fetchMaxBytes,
    fetchTimeoutMs: integer(env, 'SEARXNG_MCP_FETCH_TIMEOUT_MS', 15000, 100, 120000),
    fetchPerHostConcurrency: integer(env, 'SEARXNG_MCP_PER_HOST_CONCURRENCY', 4, 1, 256),
    fetchGlobalRateLimit: integer(env, 'SEARXNG_MCP_GLOBAL_RATE', 10, 1, 1000),
    fetchRetries: integer(env, 'SEARXNG_MCP_RETRIES', 1, 0, 5),
    userAgent,
    allowedDomains: list(env.SEARXNG_MCP_ALLOWED_DOMAINS),
    mcpEnabled: boolean(env, 'SEARXNG_MCP_ENABLED', true),
    apiEnabled: boolean(env, 'SEARXNG_API_ENABLED', false),
    fetchEnabled: boolean(env, 'SEARXNG_MCP_FETCH_ENABLED', false),
    principalsFile: env.SEARXNG_MCP_PRINCIPALS_FILE || null,
    redisUrl: env.SEARXNG_MCP_REDIS_URL || null,
    rateLimitPrefix: env.SEARXNG_MCP_RATE_LIMIT_PREFIX ?? 'searxng-mcp',
    searchRate: integer(env, 'SEARXNG_MCP_SEARCH_RATE', 50, 1, 10000),
    maxInflight: integer(env, 'SEARXNG_MCP_MAX_INFLIGHT', 64, 1, 10000),
    requestTimeoutMs: integer(env, 'SEARXNG_MCP_REQUEST_TIMEOUT_MS', 30000, 100, 300000),
    requestMaxBytes: integer(env, 'SEARXNG_MCP_REQUEST_MAX_BYTES', 65536, 1024, 1048576),
    shutdownGraceMs: integer(env, 'SEARXNG_MCP_SHUTDOWN_GRACE_MS', 35000, 100, 600000),
    searchMaxBytes: integer(env, 'SEARXNG_MCP_SEARCH_MAX_BYTES', 4 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    enginePolicyFile, enginePolicy: enginePolicyFile ? loadEnginePolicy(enginePolicyFile) : null,
    searchTimeoutMs: integer(env, 'SEARXNG_MCP_SEARCH_TIMEOUT_MS', 5000, 100, 120000),
    logLevel: logLevel(env),
    fetchPrincipalRate: integer(env, 'SEARXNG_MCP_FETCH_PRINCIPAL_RATE', 120, 1, 100000),
    fetchSharedRate: integer(env, 'SEARXNG_MCP_FETCH_SHARED_RATE', 600, 1, 1000000),
    fetchBufferBytes,
    fetchPrincipalConcurrency: integer(env, 'SEARXNG_MCP_FETCH_PRINCIPAL_CONCURRENCY', 2, 1, 64),
    htmlParseMaxChars: integer(env, 'SEARXNG_MCP_HTML_PARSE_MAX_CHARS', 2 * 1024 * 1024, 65536, 8 * 1024 * 1024),
    parseWorkers: integer(env, 'SEARXNG_MCP_PARSE_WORKERS', 2, 1, 8),
    parseHeapMb: integer(env, 'SEARXNG_MCP_PARSE_HEAP_MB', 256, 64, 2048),
  });
}
export const config = readConfig();
