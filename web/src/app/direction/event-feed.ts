import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import type { Direction } from '@worklog/model';
import { Clock, daysBetween } from '../core/clock';
import { WorklogStore } from '../core/worklog-store';
import { clearUntilFailed } from '../core/clear-until-failed';

const TIME_FORMAT = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' });
const DATE_FORMAT = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short' });

/** «сегодня 14:20», «вчера», «2 нояб» */
function timeOf(at: string, today: Date): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const days = daysBetween(date, today);
  if (days === 0) return `сегодня ${TIME_FORMAT.format(date)}`;
  if (days === 1) return 'вчера';
  return DATE_FORMAT.format(date).replace(/\.$/, '');
}

/** The «Что произошло?» field over the direction's events, newest first */
@Component({
  selector: 'wl-event-feed',
  templateUrl: './event-feed.html',
  styleUrl: './event-feed.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-event-feed' },
})
export class EventFeed {
  private readonly store = inject(WorklogStore);
  private readonly clock = inject(Clock);

  readonly direction = input.required<Direction>();

  // events are stored oldest first
  protected readonly events = computed(() => {
    const today = this.clock.today();
    return [...this.direction().events].reverse().map(event => ({ ...event, time: timeOf(event.at, today) }));
  });

  protected add(field: HTMLInputElement): void {
    const text = field.value.trim();
    if (text !== '') clearUntilFailed([field], this.store.addEvent(this.direction().id, text));
  }
}
