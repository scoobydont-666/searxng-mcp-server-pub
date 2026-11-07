import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAdmissionStore } from '../src/utils/admission.js';

/** CI starts a disposable Redis/Valkey service; never point this at production. */
const redisUrl = process.env.TEST_REDIS_URL;
describe.skipIf(!redisUrl)('Redis/Valkey distributed admission', () => {
  it('atomically bounds two independent clients and expires the shared window', async () => {
    const one = await createAdmissionStore(redisUrl!);
    const two = await createAdmissionStore(redisUrl!);
    const key = `runtime-test:${randomUUID()}`;
    try {
      const result = await Promise.all(Array.from({ length: 64 }, (_, i) =>
        (i % 2 ? one : two).take(key, 10, 400)));
      expect(result.filter(Boolean)).toHaveLength(10);
      expect(await one.ready()).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 450));
      expect(await two.take(key, 10, 400)).toBe(true);
      await one.close();
      expect(await one.ready()).toBe(false);
      await expect(one.take(key, 10, 400)).rejects.toMatchObject({ status: 503, code: 'quota_store_unavailable' });
    } finally {
      await one.close();
      await two.close();
    }
  });
});
