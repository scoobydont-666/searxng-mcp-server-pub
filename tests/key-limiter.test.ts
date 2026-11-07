import { describe, expect, it } from 'vitest';
import { KeyLimiter } from '../src/utils/key-limiter.js';

const state = async (promise: Promise<unknown>): Promise<'pending' | 'done'> => {
  let result: 'pending' | 'done' = 'pending';
  void promise.then(() => { result = 'done'; }, () => { result = 'done'; });
  await new Promise(resolve => setTimeout(resolve, 5));
  return result;
};

describe('KeyLimiter', () => {
  it('holds a key over its cap without delaying other keys, and grants FIFO on release', async () => {
    const limiter = new KeyLimiter(1);
    const a1 = await limiter.acquire('a');
    const a2 = limiter.acquire('a');
    expect(await state(a2)).toBe('pending');
    const b1 = await limiter.acquire('b');
    expect(limiter.held('b')).toBe(1);
    a1();
    const release = await a2;
    expect(limiter.held('a')).toBe(1);
    release();
    b1();
    expect(limiter.held('a')).toBe(0);
    expect(limiter.held('b')).toBe(0);
  });

  it('removes an aborted waiter from the queue and does not double-release', async () => {
    const limiter = new KeyLimiter(1);
    const first = await limiter.acquire('a');
    const ac = new AbortController();
    const waiter = limiter.acquire('a', ac.signal);
    const next = limiter.acquire('a');
    ac.abort(new Error('gone'));
    await expect(waiter).rejects.toThrow('gone');
    first();
    first();
    const release = await next;
    expect(limiter.held('a')).toBe(1);
    release();
    expect(limiter.held('a')).toBe(0);
  });
});
