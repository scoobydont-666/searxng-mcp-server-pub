import { createClient } from 'redis';

export class AdmissionError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); this.name = 'AdmissionError'; }
}
export interface AdmissionStore {
  take(key: string, limit: number, windowMs: number): Promise<boolean>;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}
/** Fixed windows anchored to the first admitted request; one Lua transaction per decision. */
export const RATE_SCRIPT = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count >= tonumber(ARGV[1]) then return 0 end
count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 1
`;
export class MemoryAdmissionStore implements AdmissionStore {
  private buckets = new Map<string, {count:number; expires:number}>();
  async take(key:string, limit:number, windowMs:number): Promise<boolean> {
    const now = Date.now();
    if (this.buckets.size > 20000) for (const [k,v] of this.buckets) if (v.expires <= now) this.buckets.delete(k);
    let b = this.buckets.get(key);
    if (!b || b.expires <= now) { b = {count:0, expires:now + windowMs}; this.buckets.set(key,b); }
    if (b.count >= limit) return false;
    b.count++; return true;
  }
  async ready(): Promise<boolean> { return true; }
  async close(): Promise<void> { this.buckets.clear(); }
}
export async function createAdmissionStore(url: string | null): Promise<AdmissionStore> {
  if (!url) return new MemoryAdmissionStore();
  const client = createClient({url, disableOfflineQueue:true, commandOptions:{timeout:1500}, socket:{connectTimeout:3000,reconnectStrategy: retries => Math.min(1000, 100 * (retries+1))}});
  client.on('error', () => { /* Request failures surface as 503, never log credential-bearing URLs. */ });
  const deadline = setTimeout(() => { if (client.isOpen) client.destroy(); }, 4000);
  try { await client.connect(); }
  catch { throw new Error('Quota store connection failed'); }
  finally { clearTimeout(deadline); }
  return {
    async take(key,limit,windowMs) {
      if (!client.isReady) throw new AdmissionError(503,'quota_store_unavailable');
      try {
        const result = await client.eval(RATE_SCRIPT,{keys:[key],arguments:[String(limit),String(windowMs)]});
        return result === 1;
      } catch { throw new AdmissionError(503,'quota_store_unavailable'); }
    },
    async ready() { if (!client.isReady) return false; try { return await client.ping() === 'PONG'; } catch { return false; } },
    async close() { if (client.isOpen) client.destroy(); },
  };
}
