import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import type { Direction, SummaryItem, WorkEvent } from '@worklog/model';
import { findAiMentions, ownDirections, STATUS_LABELS, summaryRunState, upcomingDailyAt } from '@worklog/model';
import { inBackground } from '../core/background';
import { daysBetween } from '../core/clock';
import { plural } from '../core/plural';
import { statusDot } from '../core/status-dot';
import { TabsStore } from '../core/tabs-store';
import { UpdateStore } from '../update/update-store';
import { WorklogStore } from '../core/worklog-store';
import { DailyText } from './daily-text';

const TICK_MS = 1000;
const MINUTE_MS = 60_000;
const SOON_MS = 12 * 60 * MINUTE_MS;

const DAY_FORMAT = new Intl.DateTimeFormat('ru', { weekday: 'short', day: 'numeric', month: 'long' });
const WEEKDAY_FORMAT = new Intl.DateTimeFormat('ru', { weekday: 'short' });

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function clock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function untilLabel(ms: number): string | null {
  if (ms <= 0 || ms >= SOON_MS) return null;
  const minutes = Math.ceil(ms / MINUTE_MS);
  return minutes < 60 ? `через ${minutes} мин` : `через ${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}

export interface DailyLine {
  key: string;
  kind: 'event' | 'summary';
  text: string;
  status: boolean;
  item: SummaryItem | null;
  /** why the line is marked: AI words that would go into a direction feed */
  ai: string | null;
}

function aiWarning(text: string, where: string): string | null {
  const words = findAiMentions(text);
  return words.length === 0 ? null : `Есть слова про ИИ: ${words.map(word => `«${word}»`).join(', ')} — ${where}`;
}

@Component({
  selector: 'wl-daily-view',
  imports: [NgTemplateOutlet, DailyText],
  templateUrl: './daily-view.html',
  styleUrl: './daily-view.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-daily-view' },
})
export class DailyView {
  protected readonly worklog = inject(WorklogStore);
  private readonly tabs = inject(TabsStore);
  protected readonly updates = inject(UpdateStore);

  private readonly now = signal(new Date());

  protected readonly title = computed(() => {
    const dailyAt = upcomingDailyAt(this.now(), this.worklog.state().dailies);
    const until = untilLabel(dailyAt.getTime() - this.now().getTime());
    return `Дейлик ${DAY_FORMAT.format(dailyAt)}${until === null ? '' : ` · ${until}`}`;
  });

  protected readonly period = computed(() => {
    const start = new Date(this.worklog.periodStart());
    const count = this.worklog.digest().eventCount;
    const parts = [`Период ${WEEKDAY_FORMAT.format(start)} ${clock(start)} → сейчас`, `${count} ${plural(count, { one: 'событие', few: 'события', many: 'событий' })}`];
    const sessions = this.worklog.draft()?.summary?.sessionCount;
    if (sessions !== undefined) parts.push(`${sessions} ${plural(sessions, { one: 'сессия', few: 'сессии', many: 'сессий' })}`);
    return parts.join(' · ');
  });

  protected readonly runState = computed(() => summaryRunState(this.worklog.draft()?.run ?? null, this.now()));
  protected readonly elapsed = computed(() => {
    const run = this.worklog.draft()?.run;
    if (run?.status !== 'running') return '';
    const seconds = Math.max(0, Math.floor((this.now().getTime() - new Date(run.startedAt).getTime()) / TICK_MS));
    return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
  });
  protected readonly runError = computed(() => {
    if (this.runState() !== 'failed') return null;
    const run = this.worklog.draft()?.run;
    return run?.status === 'failed' ? run.error : 'сборка прервалась';
  });

  protected readonly groups = computed(() =>
    this.worklog.digest().groups.map(group => ({
      direction: group.direction,
      dot: statusDot(group.direction.status),
      status: STATUS_LABELS[group.direction.status],
      keys: group.direction.tickets.map(t => t.key).join(' · '),
      lines: [...group.events.map(eventLine), ...group.items.map(summaryLine)],
    })),
  );
  protected readonly unbound = computed(() => this.worklog.digest().unbound.map(summaryLine));
  protected readonly candidates = computed(() =>
    (this.worklog.draft()?.summary?.candidates ?? []).map(candidate => {
      const parts = [candidate.text];
      if (candidate.requestedBy) parts.push(`от ${candidate.requestedBy}`);
      const direction = candidate.directionId === null ? undefined : this.worklog.directionById(candidate.directionId);
      if (direction) parts.push(direction.title);
      return { id: candidate.id, label: parts.join(' · '), ai: aiWarning(candidate.text, 'станет текстом дела') };
    }),
  );
  protected readonly waiting = computed(() =>
    this.worklog.digest().waiting.map(({ direction, since }) => {
      const days = daysBetween(new Date(since), this.now());
      const who = direction.waitingFor ? ` — ${direction.waitingFor}` : '';
      return { id: direction.id, title: direction.title, label: `${who} · ${days === 0 ? 'с сегодня' : `${days} дн.`}` };
    }),
  );
  private readonly openDirections = computed<Direction[]>(() => ownDirections(this.worklog.state().directions).filter(d => d.status !== 'done'));
  protected readonly empty = computed(() => this.groups().length === 0 && this.unbound().length === 0);

  constructor() {
    const timer = setInterval(() => this.now.set(new Date()), TICK_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  /** where a ✦ item can be moved; its own direction stays listed even when done */
  protected targetsFor(item: SummaryItem): Direction[] {
    const own = item.directionId === null ? undefined : this.worklog.directionById(item.directionId);
    return own !== undefined && own.status === 'done' ? [...this.openDirections(), own] : this.openDirections();
  }

  protected startSummary(): void {
    inBackground(this.worklog.startSummary());
  }

  protected open(id: string): void {
    this.tabs.openTab(`direction:${id}`);
  }

  protected remove(item: SummaryItem): void {
    inBackground(this.worklog.removeSummaryItem(item.id));
  }

  protected rebind(item: SummaryItem, value: string): void {
    inBackground(this.worklog.setSummaryItemDirection(item.id, value === '' ? null : value));
  }

  protected accept(id: string): void {
    inBackground(this.worklog.acceptCandidate(id));
  }

  protected dismiss(id: string): void {
    inBackground(this.worklog.dismissCandidate(id));
  }
}

function eventLine(event: WorkEvent): DailyLine {
  return { key: `e:${event.id}`, kind: 'event', text: event.text, status: event.kind === 'status', item: null, ai: null };
}

function summaryLine(item: SummaryItem): DailyLine {
  return { key: `s:${item.id}`, kind: 'summary', text: item.text, status: false, item, ai: aiWarning(item.text, 'уйдёт в ленту направления') };
}
