import { ChangeDetectionStrategy, Component, computed, inject, signal, viewChild } from '@angular/core';
import type { ElementRef } from '@angular/core';
import type { DailyItem } from '@worklog/model';
import { statusDot } from '../core/status-dot';
import { TabsStore } from '../core/tabs-store';
import { WorklogStore } from '../core/worklog-store';
import type { HistoryEntry } from './history-feed';
import { buildHistory, filterHistory } from './history-feed';

const PAGE_DAYS = 14;
const DAY_FORMAT = new Intl.DateTimeFormat('ru', { weekday: 'short', day: 'numeric', month: 'long' });

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

@Component({
  selector: 'wl-history-view',
  templateUrl: './history-view.html',
  styleUrl: './history-view.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-history-view', '(document:keydown.meta.f)': 'focusSearch($event)' },
})
export class HistoryView {
  private readonly worklog = inject(WorklogStore);
  private readonly tabs = inject(TabsStore);

  private readonly searchInput = viewChild.required<ElementRef<HTMLInputElement>>('searchBox');
  protected readonly query = signal('');
  protected readonly limit = signal(PAGE_DAYS);

  private readonly all = computed(() => buildHistory(this.worklog.state()));
  private readonly days = computed(() => filterHistory(this.all(), this.query()));
  protected readonly shown = computed(() => this.days().slice(0, this.limit()));
  protected readonly hasMore = computed(() => this.days().length > this.limit());

  protected dayTitle(date: string): string {
    const [year, month, day] = date.split('-').map(Number);
    return DAY_FORMAT.format(new Date(year, month - 1, day));
  }

  protected time(iso: string): string {
    const d = new Date(iso);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  protected dot(entry: HistoryEntry): string | null {
    return entry.direction === null ? null : statusDot(entry.direction.status);
  }

  protected itemLabel(item: DailyItem): string {
    return item.directionTitle ?? 'Не привязано';
  }

  protected search(value: string): void {
    this.query.set(value);
    this.limit.set(PAGE_DAYS);
  }

  protected more(): void {
    this.limit.update(limit => limit + PAGE_DAYS);
  }

  protected open(id: string): void {
    this.tabs.openTab(`direction:${id}`);
  }

  protected focusSearch(event: Event): void {
    event.preventDefault();
    this.searchInput().nativeElement.focus();
  }
}
