import { isIP } from 'node:net';
import { isPublicAddress } from './public-network.js';

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.goog',
  'kubernetes.default',
  'kubernetes.default.svc',
  'kubernetes.default.svc.cluster.local',
]);

function blockedHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost')) return true;
  return isIP(host) !== 0 && !isPublicAddress(host);
}

/** Credential-free public http(s) URL, or null. Shared by the REST API and MCP tools. */
export function publicHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    if (blockedHostname(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function boundedText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

export function boundedStringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string')
    .slice(0, maxItems)
    .map(item => item.slice(0, maxLength));
}
