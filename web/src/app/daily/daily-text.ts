import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { findAiMentions } from '@worklog/model';
import { inBackground } from '../core/background';
import { TabsStore } from '../core/tabs-store';
import { WorklogStore } from '../core/worklog-store';

const SAVE_DELAY_MS = 600;
const COPIED_MS = 2000;
const CONFIRM_MS = 4000;
const HELD_NOTE_MS = 10_000;

@Component({
  selector: 'wl-daily-text',
  templateUrl: './daily-text.html',
  styleUrl: './daily-text.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-daily-text' },
})
export class DailyText {
  protected readonly worklog = inject(WorklogStore);
  private readonly tabs = inject(TabsStore);

  private readonly focused = signal(false);
  // until every save comes back, the screen keeps what was typed rather than the older text from the server
  private readonly saving = signal(0);
  private readonly typed = signal('');
  private dirty = false;
  // the text belongs to the period it was started in, even if the field stays focused past midnight
  private focusPeriod: string | null = null;
  private heldTimer: ReturnType<typeof setTimeout> | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;
  private confirmTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly copied = signal(false);
  protected readonly confirming = signal(false);
  protected readonly held = signal(false);

  protected readonly text = computed(() => (this.focused() || this.saving() > 0 ? this.typed() : this.worklog.dailyText()));
  protected readonly badge = computed(() => {
    const draft = this.worklog.draft();
    if (this.worklog.textIsTemplate()) return 'шаблон';
    return draft?.summary && draft.textAt === draft.summary.ranAt ? '✦ из сессий' : 'правлено';
  });
  protected readonly aiWords = computed(() => findAiMentions(this.text()));
  protected readonly quote = (word: string): string => `«${word}»`;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.flush();
      clearTimeout(this.copiedTimer);
      clearTimeout(this.confirmTimer);
      clearTimeout(this.heldTimer);
    });
  }

  protected focus(): void {
    if (this.saving() === 0) this.typed.set(this.worklog.dailyText());
    this.focusPeriod = this.worklog.periodStart();
    this.dirty = false;
    this.focused.set(true);
  }

  protected input(value: string): void {
    this.typed.set(value);
    this.dirty = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), SAVE_DELAY_MS);
  }

  protected blur(): void {
    this.flush();
    this.focused.set(false);
  }

  protected rebuildFromTemplate(): void {
    inBackground(this.worklog.setDailyText(null));
  }

  protected rebuildFromSessions(): void {
    inBackground(this.worklog.startSummary());
  }

  protected copy(): void {
    inBackground(
      navigator.clipboard.writeText(this.text()).then(() => {
        this.copied.set(true);
        clearTimeout(this.copiedTimer);
        this.copiedTimer = setTimeout(() => this.copied.set(false), COPIED_MS);
      }),
    );
  }

  protected hold(): void {
    if (!this.confirming()) {
      this.confirming.set(true);
      this.confirmTimer = setTimeout(() => this.confirming.set(false), CONFIRM_MS);
      return;
    }
    clearTimeout(this.confirmTimer);
    this.confirming.set(false);
    const text = this.text();
    inBackground(
      this.worklog.holdDaily(text).then(() => {
        this.held.set(true);
        clearTimeout(this.heldTimer);
        this.heldTimer = setTimeout(() => this.held.set(false), HELD_NOTE_MS);
      }),
    );
  }

  protected openHistory(): void {
    this.tabs.openTab('history');
  }

  private flush(): void {
    if (this.saveTimer === undefined) return;
    clearTimeout(this.saveTimer);
    this.save();
  }

  private save(): void {
    this.saveTimer = undefined;
    if (!this.dirty) return;
    this.dirty = false;
    const value = this.typed();
    this.saving.update(count => count + 1);
    const saved = this.worklog.setDailyText(value.trim() === '' ? null : value, this.focusPeriod ?? undefined);
    inBackground(saved.finally(() => this.saving.update(count => count - 1)));
  }
}
