export class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;
  settled = false;
  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = (v) => {
        this.settled = true;
        res(v);
      };
      this.reject = (e) => {
        this.settled = true;
        rej(e);
      };
    });
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" ? reason : "aborted");
  err.name = "AbortError";
  return err;
}

/** Links several signals into one controller; aborting any aborts the result. */
export function linkSignals(...signals: Array<AbortSignal | undefined>): AbortController {
  const controller = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller;
}

export class TimeoutError extends Error {
  constructor(public readonly ms: number, label = "operation") {
    super(`${label} timed out after ${ms} ms`);
    this.name = "TimeoutError";
  }
}

/** Cooperative timeout: aborts the provided controller and rejects; the work itself may continue (§8.3). */
export async function withTimeout<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
  opts: { label?: string; parent?: AbortSignal } = {},
): Promise<T> {
  const controller = linkSignals(opts.parent);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new TimeoutError(ms, opts.label);
      controller.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly limit: number) {}
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return () => this.releaseOne();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    return () => this.releaseOne();
  }
  private releaseOne(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export class Mutex {
  private readonly sem = new Semaphore(1);
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.sem.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Bounded async queue for event delivery (§19.2): provisional items are dropped first when full;
 * durable items beyond capacity disconnect the consumer with a resumption cursor.
 */
export class BoundedQueue<T> {
  private items: Array<{ value: T; provisional: boolean }> = [];
  private waiters: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;
  overflow = false;
  constructor(private readonly capacity: number) {}

  push(value: T, provisional = false): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    if (this.items.length >= this.capacity) {
      const idx = this.items.findIndex((i) => i.provisional);
      if (idx !== -1) this.items.splice(idx, 1);
      else if (provisional) return;
      else {
        this.overflow = true;
        this.close();
        return;
      }
    }
    this.items.push({ value, provisional });
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item) return Promise.resolve({ value: item.value, done: false });
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}
