import { afterNextRender, ChangeDetectionStrategy, Component, computed, inject, output, signal, viewChild } from '@angular/core';
import type { ElementRef } from '@angular/core';
import { normalizeTicketKey, ticketKeyExamples } from '@worklog/model';
import { messageOf } from '../core/error-message';
import { ProfileStore } from '../core/profile-store';
import { WorklogStore } from '../core/worklog-store';

@Component({
  selector: 'wl-new-direction-form',
  templateUrl: './new-direction-form.html',
  styleUrl: './new-direction-form.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-new-direction-form', role: 'dialog', 'aria-label': 'Новое направление', '(keydown.escape)': 'closed.emit()' },
})
export class NewDirectionForm {
  private readonly store = inject(WorklogStore);
  private readonly profiles = inject(ProfileStore);
  protected readonly ticketsPlaceholder = computed(() => `Тикеты через пробел: ${ticketKeyExamples(this.profiles.profile()).join(' ')}`);
  private readonly titleInput = viewChild.required<ElementRef<HTMLInputElement>>('title');

  /** after the direction is created, and on cancel */
  readonly closed = output<void>();

  protected readonly error = signal('');
  protected readonly saving = signal(false);

  constructor() {
    afterNextRender(() => this.titleInput().nativeElement.focus());
  }

  protected create(rawTitle: string, rawTickets: string): void {
    if (this.saving()) return;
    const title = rawTitle.trim();
    if (title === '') {
      this.titleInput().nativeElement.focus();
      return;
    }
    const tickets: string[] = [];
    for (const raw of rawTickets.split(/[\s,]+/).filter(word => word !== '')) {
      const key = normalizeTicketKey(raw);
      if (key === null) {
        this.error.set(`Не похоже на ключ задачи: ${raw}`);
        return;
      }
      tickets.push(key);
    }
    this.error.set('');
    this.saving.set(true);
    this.store.createDirection(tickets.length === 0 ? { title } : { title, tickets }).then(
      () => this.closed.emit(),
      (error: unknown) => {
        this.error.set(messageOf(error, 'Не удалось создать направление'));
        // the form shows it already: the error strip would say it a second time
        this.store.dismissProblem();
        this.saving.set(false);
      },
    );
  }
}
