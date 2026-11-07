import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { config } from '../constants.js';
import { requestContext } from './request-context.js';
import { KeyLimiter } from './key-limiter.js';
import type { HtmlParseResult, PdfParseResult } from './document-parser.js';

/** Fixed, content-free failure codes. Parser messages can contain document text, so they are never surfaced. */
export class ParseFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ParseFailure';
  }
}

export type ParseTask =
  | { kind: 'html'; html: string; url: string; maxChars: number }
  | { kind: 'pdf'; data: Uint8Array }
  | { kind: 'xml-root'; text: string };

export interface ParsePoolOptions {
  size: number;
  maxOldGenerationSizeMb: number;
  entry: string;
  maxYoungGenerationSizeMb?: number;
  /** Concurrent queued or running jobs allowed per principal. Unlimited when unset. */
  principalConcurrency?: number;
}

interface Job {
  message: { id: number; task: ParseTask };
  transfer: ArrayBuffer[];
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  detach: () => void;
}

interface Slot {
  worker: Worker;
  job?: Job;
}

/**
 * Bounded pool of worker threads for untrusted document parsing. A task that is cancelled or outlives its
 * signal terminates its worker, so a runaway parse cannot hold a thread or block the event loop. A worker
 * that exceeds its heap limit or crashes fails only its own task and is replaced on demand.
 */
export class ParsePool {
  private readonly idle: Slot[] = [];
  private readonly slots = new Set<Slot>();
  private readonly queue: Job[] = [];
  private nextId = 1;
  private closed = false;

  private readonly limiter: KeyLimiter | null;

  constructor(private readonly options: ParsePoolOptions) {
    this.limiter = options.principalConcurrency ? new KeyLimiter(options.principalConcurrency) : null;
  }

  get stats(): { workers: number; busy: number; queued: number } {
    return {
      workers: this.slots.size,
      busy: [...this.slots].filter(slot => slot.job).length,
      queued: this.queue.length,
    };
  }

  async run(task: ParseTask, transfer: ArrayBuffer[], signal: AbortSignal): Promise<unknown> {
    if (this.closed) throw new ParseFailure('parser_closed');
    if (signal.aborted) throw signal.reason;
    if (!this.limiter) return this.enqueue(task, transfer, signal);
    const releasePrincipal = await this.limiter.acquire(requestContext.getStore()?.principal.id ?? '', signal);
    try {
      return await this.enqueue(task, transfer, signal);
    } finally {
      releasePrincipal();
    }
  }

  private enqueue(task: ParseTask, transfer: ArrayBuffer[], signal: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new ParseFailure('parser_closed'));
    return new Promise<unknown>((resolve, reject) => {
      const id = this.nextId++;
      const onAbort = (): void => this.cancel(job, signal.reason);
      const job: Job = {
        message: { id, task },
        transfer,
        resolve,
        reject,
        detach: () => signal.removeEventListener('abort', onAbort),
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) {
      job.detach();
      job.reject(new ParseFailure('parser_closed'));
    }
    const slots = [...this.slots];
    this.slots.clear();
    this.idle.length = 0;
    await Promise.all(slots.map(slot => {
      const job = slot.job;
      slot.job = undefined;
      job?.detach();
      job?.reject(new ParseFailure('parser_closed'));
      return slot.worker.terminate();
    }));
  }

  private cancel(job: Job, reason: unknown): void {
    const queued = this.queue.indexOf(job);
    if (queued !== -1) {
      this.queue.splice(queued, 1);
      job.detach();
      job.reject(reason);
      return;
    }
    const slot = [...this.slots].find(candidate => candidate.job === job);
    if (slot) this.retire(slot, reason);
  }

  private retire(slot: Slot, reason?: unknown): void {
    const job = slot.job;
    slot.job = undefined;
    this.slots.delete(slot);
    const index = this.idle.indexOf(slot);
    if (index !== -1) this.idle.splice(index, 1);
    void slot.worker.terminate().catch(() => undefined);
    if (job) {
      job.detach();
      job.reject(reason ?? new ParseFailure('parser_failed'));
    }
    this.pump();
  }

  private pump(): void {
    while (this.queue.length > 0) {
      let slot = this.idle.pop();
      if (!slot) {
        if (this.slots.size >= this.options.size) return;
        slot = this.spawn();
      }
      const job = this.queue.shift()!;
      slot.job = job;
      try {
        slot.worker.postMessage(job.message, job.transfer);
      } catch {
        this.retire(slot, new ParseFailure('parser_failed'));
        return;
      }
    }
  }

  private spawn(): Slot {
    const worker = new Worker(this.options.entry, {
      resourceLimits: {
        maxOldGenerationSizeMb: this.options.maxOldGenerationSizeMb,
        ...(this.options.maxYoungGenerationSizeMb ? { maxYoungGenerationSizeMb: this.options.maxYoungGenerationSizeMb } : {}),
      },
    });
    const slot: Slot = { worker };
    this.slots.add(slot);
    worker.on('message', (reply: { id: number; ok: boolean; result?: unknown; reason?: string }) => {
      const job = slot.job;
      if (!job || job.message.id !== reply.id) return;
      slot.job = undefined;
      job.detach();
      if (reply.ok) job.resolve(reply.result);
      else job.reject(new ParseFailure(reply.reason ?? 'parser_failed'));
      this.idle.push(slot);
      this.pump();
    });
    const lost = (): void => {
      if (this.slots.has(slot)) this.retire(slot);
    };
    worker.on('error', lost);
    worker.on('exit', lost);
    return slot;
  }
}

const WORKER_ENTRY = fileURLToPath(new URL('../../dist/workers/parser-worker.js', import.meta.url));
let defaultPool: ParsePool | null = null;

function pool(): ParsePool {
  defaultPool ??= new ParsePool({
    size: config.parseWorkers,
    maxOldGenerationSizeMb: config.parseHeapMb,
    maxYoungGenerationSizeMb: 32,
    principalConcurrency: config.fetchPrincipalConcurrency,
    entry: WORKER_ENTRY,
  });
  return defaultPool;
}

export async function closeParsePool(): Promise<void> {
  const current = defaultPool;
  defaultPool = null;
  if (current) await current.close();
}

/** A parse may run no longer than one fetch timeout or the time left in its request, whichever is shorter. */
export function parseSignal(): AbortSignal {
  const context = requestContext.getStore();
  const remaining = context?.deadline === undefined ? Infinity : Math.max(0, context.deadline - Date.now());
  const timeout = AbortSignal.timeout(Math.min(config.fetchTimeoutMs, remaining));
  return context ? AbortSignal.any([context.signal, timeout]) : timeout;
}

export function parseHtmlInWorker(html: string, url: string, signal: AbortSignal = parseSignal()): Promise<HtmlParseResult> {
  return pool().run({ kind: 'html', html, url, maxChars: config.htmlParseMaxChars }, [], signal) as Promise<HtmlParseResult>;
}

/** The buffer is transferred to the worker, so the caller must not read it afterwards. */
export function parsePdfInWorker(data: ArrayBuffer, signal: AbortSignal = parseSignal()): Promise<PdfParseResult> {
  return pool().run({ kind: 'pdf', data: new Uint8Array(data) }, [data], signal) as Promise<PdfParseResult>;
}

export function xmlRootInWorker(text: string, signal: AbortSignal = parseSignal()): Promise<string | null> {
  return pool().run({ kind: 'xml-root', text }, [], signal) as Promise<string | null>;
}
