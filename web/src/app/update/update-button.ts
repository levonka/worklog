import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { UpdateStore } from './update-store';

const TICK_MS = 1_000;

/** The state of a newer Worklog in the tab bar: nothing while there is none */
@Component({
  selector: 'wl-update-button',
  templateUrl: './update-button.html',
  styleUrl: './update-button.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-update-button' },
})
export class UpdateButton {
  protected readonly updates = inject(UpdateStore);

  private readonly now = signal(Date.now());

  protected readonly state = computed(() => {
    if (this.updates.reloadWaiting()) return 'reload';
    if (this.updates.running()) return 'running';
    const check = this.updates.status()?.check;
    return check === 'available' || check === 'local-changes' ? check : null;
  });

  protected readonly elapsed = computed(() => {
    const since = this.updates.runningSince();
    if (since === null) return '';
    const seconds = Math.max(0, Math.floor((this.now() - Date.parse(since)) / TICK_MS));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  });

  constructor() {
    // the timer ticks only while the update runs
    effect(onCleanup => {
      if (!this.updates.running()) return;
      this.now.set(Date.now());
      const timer = setInterval(() => this.now.set(Date.now()), TICK_MS);
      onCleanup(() => clearInterval(timer));
    });
  }
}
