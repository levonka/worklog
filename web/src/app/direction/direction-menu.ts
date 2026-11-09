import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import type { Direction } from '@worklog/model';
import { TabsStore } from '../core/tabs-store';
import { WorklogStore } from '../core/worklog-store';

const PANELS = ['main', 'confirm'] as const;
type Panel = (typeof PANELS)[number];

/** The «…» menu of the direction view: deleting the direction, confirmed inside the menu itself */
@Component({
  selector: 'wl-direction-menu',
  templateUrl: './direction-menu.html',
  styleUrl: './direction-menu.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-direction-menu', '(keydown.escape)': 'close()' },
})
export class DirectionMenu {
  private readonly store = inject(WorklogStore);
  private readonly tabs = inject(TabsStore);

  readonly direction = input.required<Direction>();

  protected readonly panel = signal<Panel | null>(null);
  protected readonly deleting = signal(false);

  protected toggle(): void {
    this.panel.set(this.panel() === null ? 'main' : null);
  }

  protected close(): void {
    this.panel.set(null);
  }

  /** The tab closes once the direction is gone; on failure the confirmation stays for another try */
  protected remove(): void {
    if (this.deleting()) return;
    const id = this.direction().id;
    this.deleting.set(true);
    this.store.deleteDirection(id).then(
      () => this.tabs.closeTab(`direction:${id}`),
      () => this.deleting.set(false),
    );
  }
}
