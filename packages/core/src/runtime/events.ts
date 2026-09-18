/** In-process event fan-out with bounded per-subscriber buffers (§19.2). Durable events are persisted first. */
import type { RunEvent } from "../types/runtime.js";
import { BoundedQueue } from "../util/async.js";

export class EventBus {
  private readonly subscribers = new Map<string, Set<BoundedQueue<RunEvent>>>();
  constructor(private readonly capacity = 1000) {}

  subscribe(runId: string): BoundedQueue<RunEvent> {
    const q = new BoundedQueue<RunEvent>(this.capacity);
    let set = this.subscribers.get(runId);
    if (!set) {
      set = new Set();
      this.subscribers.set(runId, set);
    }
    set.add(q);
    return q;
  }

  unsubscribe(runId: string, q: BoundedQueue<RunEvent>): void {
    const set = this.subscribers.get(runId);
    if (!set) return;
    set.delete(q);
    q.close();
    if (set.size === 0) this.subscribers.delete(runId);
  }

  publish(events: RunEvent[]): void {
    for (const ev of events) {
      const set = this.subscribers.get(ev.runId);
      if (!set) continue;
      for (const q of set) q.push(ev, ev.provisional === true);
    }
  }

  /** Closes every subscriber of a run (terminal or parked). */
  end(runId: string): void {
    const set = this.subscribers.get(runId);
    if (!set) return;
    for (const q of set) q.close();
    this.subscribers.delete(runId);
  }
}
