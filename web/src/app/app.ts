import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import type { OnInit } from '@angular/core';
import { AgentSheetView } from './agent/agent-sheet';
import { AgentSheet } from './core/agent-sheet';
import { NO_CONNECTION } from './core/error-message';
import { Hotkeys } from './core/hotkeys';
import { LiveUpdates } from './core/live-updates';
import { ProfileStore } from './core/profile-store';
import { TabsStore } from './core/tabs-store';
import { WorklogStore } from './core/worklog-store';
import { Pane } from './pane/pane';
import { Sidebar } from './sidebar/sidebar';
import { TabBar } from './tab-bar/tab-bar';
import { inBackground } from './core/background';

interface Problem {
  text: string;
  dismissible: boolean;
}

@Component({
  selector: 'wl-root',
  imports: [AgentSheetView, Sidebar, TabBar, Pane],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-root', '(document:keydown)': 'hotkeys.handle($event)' },
})
export class App implements OnInit {
  protected readonly store = inject(WorklogStore);
  private readonly profiles = inject(ProfileStore);
  private readonly live = inject(LiveUpdates);
  protected readonly tabs = inject(TabsStore);
  protected readonly hotkeys = inject(Hotkeys);
  protected readonly agentSheet = inject(AgentSheet);

  protected readonly problem = computed<Problem | null>(() => {
    if (!this.live.connected()) return { text: NO_CONNECTION, dismissible: false };
    const loadError = this.store.loadError();
    if (loadError !== null) return { text: loadError, dismissible: false };
    const actionError = this.store.actionError();
    return actionError === null ? null : { text: actionError, dismissible: true };
  });

  ngOnInit(): void {
    inBackground(this.profiles.load());
    inBackground(this.store.refresh());
    this.live.start();
  }

  protected startResize(event: PointerEvent): void {
    if (event.button !== 0 || !(event.currentTarget instanceof Element)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  // the divider keeps the pointer captured from pointerdown to pointerup
  protected resize(event: PointerEvent, panes: HTMLElement): void {
    const divider = event.currentTarget;
    if (!(divider instanceof HTMLElement) || !divider.hasPointerCapture(event.pointerId)) return;
    const area = panes.getBoundingClientRect();
    const half = divider.offsetWidth / 2;
    this.tabs.setRatio((event.clientX - area.left - half) / (area.width - 2 * half));
  }
}
