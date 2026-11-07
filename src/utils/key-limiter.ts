interface KeyWaiter {
  grant: () => void;
  abort: () => void;
}

/**
 * Caps concurrent holders per key. A key over its cap waits in its own FIFO, so it never occupies a
 * position in a shared queue. Waiters leave on their own signal. Release is idempotent.
 */
export class KeyLimiter {
  private readonly active = new Map<string, number>();
  private readonly waiting = new Map<string, KeyWaiter[]>();

  constructor(private readonly limit: number) {}

  held(key: string): number {
    return this.active.get(key) ?? 0;
  }

  acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.held(key) < this.limit) return Promise.resolve(this.take(key));
    return new Promise<() => void>((resolve, reject) => {
      const queue = this.waiting.get(key) ?? [];
      this.waiting.set(key, queue);
      const waiter: KeyWaiter = {
        grant: () => {
          signal?.removeEventListener('abort', waiter.abort);
          resolve(this.take(key));
        },
        abort: () => {
          const index = queue.indexOf(waiter);
          if (index !== -1) queue.splice(index, 1);
          if (queue.length === 0 && this.waiting.get(key) === queue) this.waiting.delete(key);
          reject(signal?.reason);
        },
      };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      queue.push(waiter);
    });
  }

  private take(key: string): () => void {
    this.active.set(key, this.held(key) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = this.held(key) - 1;
      if (remaining <= 0) this.active.delete(key);
      else this.active.set(key, remaining);
      const queue = this.waiting.get(key);
      const next = queue?.shift();
      if (queue && queue.length === 0) this.waiting.delete(key);
      next?.grant();
    };
  }
}
