import { DOCUMENT } from '@angular/common';
import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import type { UpdateCheckResult, UpdateStatus } from '@worklog/model';
import { updateFailureText } from '@worklog/model';
import { firstValueFrom } from 'rxjs';
import { ApiClient } from '../core/api';
import { inBackground } from '../core/background';
import { messageOf } from '../core/error-message';
import { saveScroll } from './scroll-keep';

export const UPDATE_POLL_MS = 2_000;

// a checkbox keeps the focus after a click, yet a reload loses nothing typed in it
const TYPING = 'input:not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable]:not([contenteditable="false"])';
const EDITING = `${TYPING}, select`;

/** typed into and not sent yet: still on screen and not empty; a field that saves itself is marked `data-autosave` */
function unsent(field: Element): boolean {
  if (!field.isConnected || field.closest('[data-autosave]') !== null) return false;
  const text = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.value : (field.textContent ?? '');
  return text.trim() !== '';
}

/** a reload now cuts nothing short: no field being typed in or left with unsent text, no task window, tour, menu or form open */
export function canReloadNow(doc: Document, typed: Iterable<Element> = []): boolean {
  if (doc.activeElement?.matches(EDITING) === true) return false;
  if (doc.querySelector('dialog[open], [aria-modal="true"], [aria-expanded="true"]') !== null) return false;
  return !Array.from(typed).some(unsent);
}

/** A newer Worklog on GitHub, the update the window started, and the reload into the new version */
@Injectable({ providedIn: 'root' })
export class UpdateStore {
  private readonly api = inject(ApiClient);
  private readonly document = inject(DOCUMENT);
  private readonly current = signal<UpdateStatus | null>(null);
  // the start asks GitHub first: a few seconds before the run exists
  private readonly startingAt = signal<string | null>(null);
  private readonly refusal = signal<string | null>(null);
  private readonly waiting = signal(false);
  /** the server version this window was loaded from */
  private version: string | null = null;
  private poll: ReturnType<typeof setTimeout> | undefined;
  /** fields typed into since the window loaded: a form left open with text, the focus gone elsewhere */
  private readonly typed = new Set<Element>();

  readonly status = this.current.asReadonly();
  /** when the running update started, null when none runs */
  readonly runningSince = computed(() => {
    const run = this.current()?.run;
    return run?.phase === 'running' ? run.startedAt : this.startingAt();
  });
  readonly running = computed(() => this.runningSince() !== null);
  readonly failure = computed(() => {
    const run = this.current()?.run;
    return this.refusal() ?? (run?.phase === 'failed' ? updateFailureText(run) : null);
  });
  readonly reloadWaiting = this.waiting.asReadonly();
  /** the server looks for new versions: not in the demo, the tests or outside git */
  readonly enabled = computed(() => (this.current()?.version ?? null) !== null);

  constructor() {
    const remember = (event: Event): void => {
      if (event.target instanceof Element && event.target.matches(TYPING)) this.typed.add(event.target);
    };
    this.document.addEventListener('input', remember, true);
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.poll);
      this.document.removeEventListener('input', remember, true);
    });
  }

  // never rejects: while the server restarts the last status stays
  async load(): Promise<void> {
    try {
      this.apply(await firstValueFrom(this.api.getUpdate()));
    } catch {
      // the connection banner tells about a server that is down
    }
    // a window opened in the middle of an update follows it too
    if (this.running()) this.schedulePoll();
  }

  // never rejects: a refusal goes to the error strip
  async start(): Promise<void> {
    if (this.running()) return;
    this.refusal.set(null);
    this.startingAt.set(new Date().toISOString());
    try {
      const { run } = await firstValueFrom(this.api.startUpdate());
      this.current.update(status => ({ check: status?.check ?? 'available', version: status?.version ?? null, run }));
    } catch (error) {
      this.refusal.set(messageOf(error, 'Не удалось запустить обновление'));
    } finally {
      this.startingAt.set(null);
    }
    // after a refusal too: no new version or own edits found just now take the button away
    await this.load();
  }

  /** asks GitHub now; never rejects: without an answer it could not check */
  async checkNow(): Promise<UpdateCheckResult> {
    try {
      const { result, status } = await firstValueFrom(this.api.checkUpdate());
      this.apply(status);
      return result;
    } catch {
      return 'unreachable';
    }
  }

  // never rejects
  async dismiss(): Promise<void> {
    if (this.refusal() !== null) {
      this.refusal.set(null);
      return;
    }
    const status = this.current();
    if (status?.run?.phase !== 'failed') return;
    this.current.set({ ...status, run: null });
    await firstValueFrom(this.api.dismissUpdateRun()).catch(() => undefined);
  }

  /** into the new version on the same place: tabs and the sidebar keep themselves, the scroll of the panes is kept here */
  reload(): void {
    const view = this.document.defaultView;
    try {
      if (view !== null) saveScroll(this.document, view.sessionStorage);
    } catch {
      // storage unavailable: the panes start at the top
    }
    view?.location.reload();
  }

  private apply(status: UpdateStatus): void {
    this.current.set(status);
    if (status.version === null) return;
    if (this.version === null) {
      this.version = status.version;
      return;
    }
    // a new server that fails its check is rolled back: the window follows a version only once the update is over
    if (status.run?.phase === 'running') return;
    if (status.version === this.version) {
      this.waiting.set(false);
      return;
    }
    if (this.waiting()) return;
    for (const field of this.typed) if (!field.isConnected) this.typed.delete(field);
    if (canReloadNow(this.document, this.typed)) this.reload();
    else this.waiting.set(true);
  }

  private schedulePoll(): void {
    if (this.poll !== undefined) return;
    this.poll = setTimeout(() => {
      this.poll = undefined;
      inBackground(this.load());
    }, UPDATE_POLL_MS);
  }
}
