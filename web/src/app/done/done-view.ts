import { ChangeDetectionStrategy, Component, computed, ElementRef, inject, signal, viewChild } from '@angular/core';
import { ownDirections } from '@worklog/model';
import { Clock } from '../core/clock';
import { plural } from '../core/plural';
import { TabsStore } from '../core/tabs-store';
import { WorklogStore } from '../core/worklog-store';
import type { DoneMonth } from './done-feed';
import { doneMonths, doneYears, MONTH_NAMES, MONTH_SHORT, monthBars, shortDate } from './done-feed';
import { ProfileStore } from '../core/profile-store';

const DIRECTION_FORMS = { one: 'направление', few: 'направления', many: 'направлений' };
const TASK_FORMS = { one: 'задача', few: 'задачи', many: 'задач' };
/** a direction with only its tickets in the profile's projects shows no count */
const COUNT_FROM = 3;

function counted(directions: number, tickets: number): string {
  return `${directions} ${plural(directions, DIRECTION_FORMS)} · ${tickets} ${plural(tickets, TASK_FORMS)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

interface Bar {
  month: number;
  label: string;
  count: number;
  /** percent of the busiest month */
  height: number;
  current: boolean;
}

@Component({
  selector: 'wl-done-view',
  templateUrl: './done-view.html',
  styleUrl: './done-view.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-done-view', '(document:keydown.meta.f)': 'focusSearch($event)' },
})
export class DoneView {
  private readonly worklog = inject(WorklogStore);
  private readonly tabs = inject(TabsStore);
  private readonly clock = inject(Clock);
  private readonly profiles = inject(ProfileStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  private readonly searchInput = viewChild.required<ElementRef<HTMLInputElement>>('searchBox');
  protected readonly query = signal('');
  private readonly chosenYear = signal<number | null>(null);

  private readonly directions = computed(() => ownDirections(this.worklog.state().directions));
  protected readonly years = computed(() => doneYears(this.directions()));
  protected readonly searching = computed(() => this.query().trim() !== '');
  // a chosen year left without done directions gives way to the latest one
  protected readonly year = computed(() => {
    const chosen = this.chosenYear();
    return chosen !== null && this.years().includes(chosen) ? chosen : (this.years()[0] ?? null);
  });
  protected readonly months = computed<DoneMonth[]>(() => {
    if (this.searching()) return doneMonths(this.directions(), { query: this.query() }, this.profiles.profile());
    const year = this.year();
    return year === null ? [] : doneMonths(this.directions(), { year }, this.profiles.profile());
  });
  protected readonly summary = computed(() => {
    const months = this.months();
    const directions = months.reduce((sum, m) => sum + m.rows.length, 0);
    const tickets = months.reduce((sum, m) => sum + m.tickets, 0);
    return `${counted(directions, tickets)} за ${this.year()}`;
  });
  protected readonly bars = computed<Bar[]>(() => {
    const year = this.year();
    if (year === null) return [];
    const counts = monthBars(this.months(), year);
    const busiest = Math.max(...counts, 1);
    const today = this.clock.today();
    return counts.map((count, month) => ({
      month,
      label: MONTH_SHORT[month],
      count,
      height: (count / busiest) * 100,
      current: today.getFullYear() === year && today.getMonth() === month,
    }));
  });

  protected monthKey(month: DoneMonth): string {
    return `${month.year}-${pad(month.month + 1)}`;
  }

  protected monthTitle(month: DoneMonth): string {
    return this.searching() ? `${MONTH_NAMES[month.month]} ${month.year}` : MONTH_NAMES[month.month];
  }

  protected monthMeta(month: DoneMonth): string {
    return counted(month.rows.length, month.tickets);
  }

  protected barLabel(bar: Bar): string {
    return `${MONTH_NAMES[bar.month]}: ${bar.count} ${plural(bar.count, DIRECTION_FORMS)}`;
  }

  protected count(tickets: number): string | null {
    return tickets >= COUNT_FROM ? `${tickets} ${plural(tickets, TASK_FORMS)}` : null;
  }

  protected date(iso: string): string {
    return shortDate(iso);
  }

  protected chooseYear(year: number): void {
    this.chosenYear.set(year);
  }

  protected search(value: string): void {
    this.query.set(value);
  }

  protected scrollTo(month: number): void {
    const key = `${this.year()}-${pad(month + 1)}`;
    this.host.nativeElement.querySelector(`[data-month="${key}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  protected open(id: string): void {
    this.tabs.openTab(`direction:${id}`);
  }

  protected focusSearch(event: Event): void {
    event.preventDefault();
    this.searchInput().nativeElement.focus();
  }
}
