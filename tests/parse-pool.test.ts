import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { ParsePool, ParseFailure, type ParseTask } from '../src/utils/parse-pool.js';

const realWorker = fileURLToPath(new URL('../dist/workers/parser-worker.js', import.meta.url));
const spinWorker = fileURLToPath(new URL('./fixtures/spin-worker.mjs', import.meta.url));
const pools: ParsePool[] = [];
const make = (entry: string, size = 1, heapMb = 256): ParsePool => {
  const pool = new ParsePool({ size, maxOldGenerationSizeMb: heapMb, entry });
  pools.push(pool);
  return pool;
};
const asTask = (task: unknown): ParseTask => task as ParseTask;

afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.close()));
});

describe('parser worker pool', () => {
  it('parses HTML and XML in a worker thread with the production entry point', async () => {
    const pool = make(realWorker);
    const html = '<html><body><article><h1>Title</h1><p>Useful body text for the extraction fixture.</p></article></body></html>';
    const parsed = await pool.run(asTask({ kind: 'html', html, url: 'https://example.com/a', maxChars: 1_000_000 }), [], AbortSignal.timeout(10_000));
    expect(parsed).toMatchObject({ extraction: 'readability' });
    const root = await pool.run(asTask({ kind: 'xml-root', text: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>' }), [], AbortSignal.timeout(10_000));
    expect(root).toBe('feed');
  });

  it('kills a runaway worker when the task deadline passes and then serves the next task', async () => {
    const pool = make(spinWorker);
    await expect(pool.run(asTask({ kind: 'spin' }), [], AbortSignal.timeout(150))).rejects.toThrow();
    expect(pool.stats).toEqual({ workers: 0, busy: 0, queued: 0 });
    await expect(pool.run(asTask({ kind: 'echo' }), [], AbortSignal.timeout(10_000))).resolves.toEqual({ echo: 'echo' });
  });

  it('fails only the task whose worker exceeds its heap limit and keeps the pool serving', async () => {
    const pool = make(spinWorker, 1, 32);
    await expect(pool.run(asTask({ kind: 'oom' }), [], AbortSignal.timeout(10_000))).rejects.toMatchObject({ reason: 'parser_failed' });
    await expect(pool.run(asTask({ kind: 'echo' }), [], AbortSignal.timeout(10_000))).resolves.toEqual({ echo: 'echo' });
  });

  it('removes a queued task on abort without running it', async () => {
    const pool = make(spinWorker, 1);
    const running = pool.run(asTask({ kind: 'spin' }), [], AbortSignal.timeout(300));
    const queued = new AbortController();
    const waiting = pool.run(asTask({ kind: 'echo' }), [], queued.signal);
    queued.abort(new Error('client went away'));
    await expect(waiting).rejects.toThrow('client went away');
    await expect(running).rejects.toThrow();
    expect(pool.stats.queued).toBe(0);
  });

  it('rejects new work and queued work after close', async () => {
    const pool = make(spinWorker, 1);
    const running = pool.run(asTask({ kind: 'spin' }), [], AbortSignal.timeout(10_000)).catch((error: unknown) => error);
    const queued = pool.run(asTask({ kind: 'echo' }), [], AbortSignal.timeout(10_000)).catch((error: unknown) => error);
    await pool.close();
    expect(await running).toBeInstanceOf(ParseFailure);
    expect(await queued).toMatchObject({ reason: 'parser_closed' });
    await expect(pool.run(asTask({ kind: 'echo' }), [], AbortSignal.timeout(1_000))).rejects.toMatchObject({ reason: 'parser_closed' });
  });
});
