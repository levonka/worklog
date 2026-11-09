import { AsyncLocalStorage } from 'node:async_hooks';
import type { FileChange, Store } from './store.ts';

const MAX_STEPS = 100;
// saves of one text a minute apart or closer are one step, not one per typing pause
const MERGE_MS = 60_000;

export type HistoryResult = 'applied' | 'empty' | 'conflict';

interface Request {
  step: FileChange[] | null;
  mergeKey: string | null;
}

/** Undo and redo for changes made through the API; one request is one step */
export class History {
  private readonly undoSteps: FileChange[][] = [];
  private readonly redoSteps: FileChange[][] = [];
  private readonly request = new AsyncLocalStorage<Request>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastKey: string | null = null;
  private lastAt = 0;

  /** `mergeKey`: consecutive requests with the same key join the last undo step */
  track<T>(fn: () => Promise<T>, mergeKey: string | null = null): Promise<T> {
    return this.request.run({ step: null, mergeKey }, fn);
  }

  // called by Store after every commit; commits outside track (the CLI, tests) are not undoable
  record(changes: readonly FileChange[]): void {
    const request = this.request.getStore();
    if (request === undefined) return;
    if (request.step === null) {
      const now = Date.now();
      const last = this.undoSteps.at(-1);
      const joins = request.mergeKey !== null && request.mergeKey === this.lastKey && now - this.lastAt < MERGE_MS;
      if (joins && last !== undefined) {
        request.step = last;
      } else {
        request.step = [];
        this.undoSteps.push(request.step);
        if (this.undoSteps.length > MAX_STEPS) this.undoSteps.shift();
      }
      this.redoSteps.length = 0;
      this.lastKey = request.mergeKey;
      this.lastAt = now;
    }
    for (const change of changes) {
      const earlier = request.step.find(item => item.file === change.file);
      if (earlier === undefined) request.step.push({ ...change });
      else earlier.after = change.after;
    }
  }

  undo(store: Store): Promise<HistoryResult> {
    return this.serially(() => this.move(store, this.undoSteps, this.redoSteps, 'back'));
  }

  redo(store: Store): Promise<HistoryResult> {
    return this.serially(() => this.move(store, this.redoSteps, this.undoSteps, 'forward'));
  }

  private serially(fn: () => Promise<HistoryResult>): Promise<HistoryResult> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // a step whose files were changed since cannot be applied any more and is dropped
  private async move(store: Store, from: FileChange[][], to: FileChange[][], direction: 'back' | 'forward'): Promise<HistoryResult> {
    this.lastKey = null;
    const step = from.pop();
    if (step === undefined) return 'empty';
    let applied: boolean;
    try {
      applied = await store.restore(step, direction);
    } catch (error) {
      from.push(step);
      throw error;
    }
    if (!applied) return 'conflict';
    to.push(step);
    return 'applied';
  }
}
