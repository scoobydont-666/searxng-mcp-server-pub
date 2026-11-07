interface Waiter {
  bytes: number;
  signal?: AbortSignal;
  grant: () => void;
  abort: () => void;
}

/**
 * Process-wide cap on bytes held by buffered response bodies. A reservation waits (FIFO, so large requests
 * are not starved) until it fits, and gives up when its signal aborts. Release is idempotent.
 */
export class ByteBudget {
  private used = 0;
  private readonly waiting: Waiter[] = [];

  constructor(readonly capacity: number) {}

  get inUse(): number {
    return this.used;
  }

  acquire(bytes: number, signal?: AbortSignal): Promise<() => void> {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.capacity) {
      return Promise.reject(new RangeError('byte reservation outside budget'));
    }
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        bytes,
        signal,
        grant: () => {
          signal?.removeEventListener('abort', waiter.abort);
          resolve(this.reserve(bytes));
        },
        abort: () => {
          const index = this.waiting.indexOf(waiter);
          if (index !== -1) this.waiting.splice(index, 1);
          reject(signal?.reason);
          this.drain();
        },
      };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.waiting.push(waiter);
      this.drain();
    });
  }

  private reserve(bytes: number): () => void {
    this.used += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= bytes;
      this.drain();
    };
  }

  private drain(): void {
    while (this.waiting.length > 0 && this.used + this.waiting[0].bytes <= this.capacity) {
      this.waiting.shift()!.grant();
    }
  }
}
