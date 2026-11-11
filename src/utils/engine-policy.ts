import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { AdmissionError } from './admission.js';

export const SEARCH_CATEGORIES = ['general', 'news', 'images', 'videos', 'science'] as const;
export type SearchCategory = typeof SEARCH_CATEGORIES[number];
export const LANGUAGE_TAG = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/;
const EngineName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_. -]{0,127}$/);
const Pool = z.array(EngineName).min(1).max(4);
const CategoryPolicy = z.object({ primary: Pool, fallbacks: z.array(Pool).max(2) }).strict();
const PolicySchema = z.object({
  engines: z.array(EngineName).min(1).max(1024),
  categories: z.object({
    general: CategoryPolicy, news: CategoryPolicy, images: CategoryPolicy,
    videos: CategoryPolicy, science: CategoryPolicy,
  }).strict(),
}).strict();
export type EnginePolicy = z.infer<typeof PolicySchema>;

export function parseEnginePolicy(value: unknown): EnginePolicy {
  const policy = PolicySchema.parse(value);
  const inventory = new Set(policy.engines);
  if (inventory.size !== policy.engines.length) throw new Error('Duplicate engine inventory name');
  for (const category of SEARCH_CATEGORIES) {
    const selected = new Set<string>();
    for (const pool of [policy.categories[category].primary, ...policy.categories[category].fallbacks]) {
      for (const name of pool) {
        if (!inventory.has(name)) throw new Error('Policy pool uses an engine outside the inventory');
        if (selected.has(name)) throw new Error('Primary and fallback pools must use distinct engines');
        selected.add(name);
      }
    }
  }
  return policy;
}

export function loadEnginePolicy(path: string): EnginePolicy {
  try { return parseEnginePolicy(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { throw new Error('Invalid or unreadable engine policy'); }
}

export function requireEnginePolicy(policy: EnginePolicy | null): asserts policy is EnginePolicy {
  if (!policy) throw new Error('SEARXNG_MCP_ENGINE_POLICY_FILE is required');
  parseEnginePolicy(policy);
}

/** Python's query tokenizer also splits on NEL and the C0 information separators. */
export function rejectQueryOverrides(query: string): void {
  if (/(^|[\s\u001c-\u001f\u0085])![^\s\u001c-\u001f\u0085]+/u.test(query)) {
    throw new AdmissionError(400, 'engine_bang_not_allowed');
  }
  if (/(^|[\s\u001c-\u001f\u0085])<\p{N}+($|[\s\u001c-\u001f\u0085])/u.test(query)) {
    throw new AdmissionError(400, 'timeout_override_not_allowed');
  }
}

export function enginePlan(policy: EnginePolicy | null, category: string, explicit?: string): string[][] {
  if (!policy) throw new AdmissionError(503, 'engine_policy_unavailable');
  if (!(SEARCH_CATEGORIES as readonly string[]).includes(category)) throw new AdmissionError(400, 'category_not_allowed');
  if (explicit !== undefined) {
    const names = explicit.split(',').map(name => name.trim());
    if (!names.length || names.length > 4 || new Set(names).size !== names.length || names.some(name => !policy.engines.includes(name))) {
      throw new AdmissionError(400, 'engine_not_allowed');
    }
    // Explicit engine choices never silently switch to a different requested source.
    return [names];
  }
  const configured = policy.categories[category as SearchCategory];
  return [configured.primary, ...configured.fallbacks];
}
