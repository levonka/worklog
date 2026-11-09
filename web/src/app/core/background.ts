/** For a write nobody awaits: its failure is already shown in the error strip */
export function inBackground(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}
