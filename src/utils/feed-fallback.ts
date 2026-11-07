import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { xmlRootInWorker } from './parse-pool.js';

const AlternativeSchema = z.object({
  name: z.string().min(1).max(96),
  kind: z.enum(['rss', 'atom', 'api']),
  urlTemplate: z.string().min(1).max(2048),
}).strict();
const RuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,95}$/),
  sourceHost: z.string().min(1).max(253),
  sourcePath: z.string().min(1).max(512),
  alternatives: z.array(AlternativeSchema).min(1).max(2),
}).strict();
const PolicySchema = z.object({
  version: z.literal(1),
  maxAlternatives: z.number().int().min(1).max(2),
  triggerStatuses: z.array(z.union([z.literal(403), z.literal(429), z.literal(503)])).min(1).max(3),
  rules: z.array(RuleSchema).max(100),
}).strict();

export type FeedPolicy = z.infer<typeof PolicySchema>;
export interface AlternativeSource { name: string; kind: 'rss' | 'atom' | 'api'; url: string; rule: string }
export interface AlternativeProvenance extends AlternativeSource {
  original_url: string;
  original_status: number;
  semantics: 'alternative_source_not_original_page';
}

/** A 200 HTML challenge is not a successful feed or API response. XML is parsed in the parser worker. */
export async function isAlternativeContent(kind: AlternativeSource['kind'], contentType: string, body: ArrayBuffer): Promise<boolean> {
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  const text = new TextDecoder().decode(body);
  if (kind === 'api' && (mediaType === 'application/json' || mediaType.endsWith('+json'))) {
    if (mediaType === 'application/problem+json') return false;
    try {
      const data: unknown = JSON.parse(text);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
      for (const [key, value] of Object.entries(data)) {
        if (/error|captcha|challenge/i.test(key)) return false;
        if (typeof value === 'string' && /^(?:captcha|challenge)$/i.test(value.trim())) return false;
      }
      return Object.keys(data).length > 0;
    } catch { return false; }
  }
  if (!['application/xml', 'text/xml', 'application/atom+xml', 'application/rss+xml', 'application/rdf+xml'].includes(mediaType)) return false;
  try {
    const root = await xmlRootInWorker(text);
    return root !== null && ['feed', 'entry', 'rss', 'RDF'].includes(root);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    return false;
  }
}
const CAPTURE = /^\{([a-z][a-z0-9_]{0,31})\}$/;

function pathParts(path: string): string[] {
  return path.replace(/\/$/, '').split('/').slice(1);
}

export function parseFeedPolicy(input: unknown): FeedPolicy {
  const policy = PolicySchema.parse(input);
  const ids = new Set<string>();
  for (const rule of policy.rules) {
    if (ids.has(rule.id)) throw new Error('Duplicate feed rule id');
    ids.add(rule.id);
    const host = new URL(`https://${rule.sourceHost}`);
    if (host.hostname !== rule.sourceHost || host.host !== rule.sourceHost || host.pathname !== '/' ||
        host.username || host.password || host.search || host.hash) throw new Error('Feed sourceHost must be an exact lowercase host');
    if (!rule.sourcePath.startsWith('/') || /[?#]/.test(rule.sourcePath)) throw new Error('Invalid feed source path');
    const parts = pathParts(rule.sourcePath);
    const captures = new Set<string>();
    parts.forEach((part, index) => {
      const match = CAPTURE.exec(part);
      if (match) {
        if (captures.has(match[1])) throw new Error('Duplicate feed path capture');
        captures.add(match[1]);
      } else if (part === '**' && index === parts.length - 1) {
        // Final catch-all can match a publisher-wide feed; it is never interpolated.
      } else if (!/^[a-zA-Z0-9._~-]*$/.test(part)) throw new Error('Invalid feed path segment');
    });
    for (const alternative of rule.alternatives) {
      const placeholders = [...alternative.urlTemplate.matchAll(/\{([a-z][a-z0-9_]*)\}/g)];
      if (placeholders.some(match => !captures.has(match[1]))) throw new Error('Unknown feed template capture');
      const replaced = alternative.urlTemplate.replace(/\{[a-z][a-z0-9_]*\}/g, 'sample');
      if (/[{}]/.test(replaced)) throw new Error('Malformed feed template');
      const target = new URL(replaced);
      if (target.protocol !== 'https:' || target.username || target.password || target.hash ||
          (target.port && target.port !== '443')) throw new Error('Feed destinations require credential-free HTTPS on port 443');
      // Captures must not influence scheme, authority, credentials, or port.
      const authority = alternative.urlTemplate.split('/').slice(0, 3).join('/');
      if (authority.includes('{')) throw new Error('Feed destination host must be fixed');
    }
  }
  return policy;
}

export function loadFeedPolicy(file = process.env.SEARXNG_MCP_FEED_POLICY_FILE): FeedPolicy | null {
  if (!file) return null;
  try {
    const contents = readFileSync(file, 'utf8');
    if (Buffer.byteLength(contents) > 256 * 1024) throw new Error('Feed policy too large');
    return parseFeedPolicy(JSON.parse(contents));
  } catch {
    throw new Error('Invalid or unreadable feed policy; no alternative sources were enabled');
  }
}

export function resolveAlternatives(policy: FeedPolicy | null, original: string, status: number): AlternativeSource[] {
  if (!policy || !policy.triggerStatuses.includes(status as 403 | 429 | 503)) return [];
  const source = new URL(original);
  if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password) return [];
  const actual = pathParts(source.pathname);
  const candidates: AlternativeSource[] = [];
  for (const rule of policy.rules) {
    if (source.hostname !== rule.sourceHost) continue;
    const expected = pathParts(rule.sourcePath);
    const captures: Record<string, string> = {};
    let matches = true;
    for (let index = 0; index < expected.length; index++) {
      const wanted = expected[index];
      if (wanted === '**') break;
      const part = actual[index];
      if (part === undefined) { matches = false; break; }
      const capture = CAPTURE.exec(wanted);
      if (capture) {
        let decoded: string;
        try { decoded = decodeURIComponent(part); } catch { matches = false; break; }
        if (!/^[a-zA-Z0-9._~-]+$/.test(decoded) || decoded === '.' || decoded === '..') { matches = false; break; }
        captures[capture[1]] = encodeURIComponent(decoded);
      } else if (part !== wanted) { matches = false; break; }
    }
    if (expected.at(-1) !== '**' && actual.length !== expected.length) matches = false;
    if (!matches) continue;
    for (const alternative of rule.alternatives) {
      const url = new URL(alternative.urlTemplate.replace(/\{([a-z][a-z0-9_]*)\}/g, (_, name: string) => captures[name]));
      // A 429 Retry-After applies to the provider: don't immediately retry another
      // path on the same origin. An independently operated official API can differ.
      if (status === 429 && url.origin === source.origin) continue;
      if (url.toString() === source.toString() || candidates.some(item => item.url === url.toString())) continue;
      candidates.push({name:alternative.name, kind:alternative.kind, url:url.toString(), rule:rule.id});
      if (candidates.length >= policy.maxAlternatives) return candidates;
    }
  }
  return candidates;
}
