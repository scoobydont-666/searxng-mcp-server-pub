import { describe, expect, it } from 'vitest';
import { ByteBudget } from '../src/utils/byte-budget.js';

const settled = async (promise: Promise<unknown>): Promise<'pending' | 'done'> => {
  let state: 'pending' | 'done' = 'pending';
  void promise.then(() => { state = 'done'; }, () => { state = 'done'; });
  await new Promise(resolve => setTimeout(resolve, 5));
  return state;
};

describe('ByteBudget', () => {
  it('admits reservations that fit and blocks one that would exceed the capacity', async () => {
    const budget = new ByteBudget(10);
    const first = await budget.acquire(6);
    const second = budget.acquire(6);
    expect(await settled(second)).toBe('pending');
    first();
    const release = await second;
    expect(budget.inUse).toBe(6);
    release();
    expect(budget.inUse).toBe(0);
  });

  it('grants waiting reservations in arrival order without letting later small ones jump the queue', async () => {
    const budget = new ByteBudget(10);
    const holder = await budget.acquire(8);
    const order: string[] = [];
    const large = budget.acquire(9).then(release => { order.push('large'); return release; });
    const small = budget.acquire(1).then(release => { order.push('small'); return release; });
    expect(await settled(small)).toBe('pending');
    holder();
    (await large)();
    (await small)();
    expect(order).toEqual(['large', 'small']);
  });

  it('aborts a waiting reservation and leaves the budget usable', async () => {
    const budget = new ByteBudget(10);
    const holder = await budget.acquire(10);
    const controller = new AbortController();
    const waiting = budget.acquire(5, controller.signal);
    controller.abort(new Error('request deadline'));
    await expect(waiting).rejects.toThrow('request deadline');
    holder();
    const release = await budget.acquire(10);
    expect(budget.inUse).toBe(10);
    release();
    expect(budget.inUse).toBe(0);
  });

  it('rejects a reservation larger than the whole budget instead of waiting forever', async () => {
    await expect(new ByteBudget(10).acquire(11)).rejects.toBeInstanceOf(RangeError);
  });

  it('treats release as idempotent so a double release cannot inflate capacity', async () => {
    const budget = new ByteBudget(10);
    const release = await budget.acquire(4);
    release();
    release();
    expect(budget.inUse).toBe(0);
    const other = await budget.acquire(10);
    expect(budget.inUse).toBe(10);
    other();
  });
});
