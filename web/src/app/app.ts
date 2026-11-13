import { ChangeDetectionStrategy, Component, computed, effect, inject, untracked } from '@angular/core';
import { EMPTY_STATE } from '@worklog/model';
import type { OnInit } from '@angular/core';
import { AgentSheetView } from './agent/agent-sheet';
import { AgentSheet } from './core/agent-sheet';
import { NO_CONNECTION } from './core/error-message';
import { Hotkeys } from './core/hotkeys';
import { LiveUpdates } from './core/live-updates';
import { ProfileStore } from './core/profile-store';
import { TabsStore } from './core/tabs-store';
import { WorklogStore } from './core/worklog-store';
import { Tour } from './onboarding/tour';
import { UpdateStore } from './update/update-store';
import { TourOverlay } from './onboarding/tour-overlay';
import { Pane } from './pane/pane';
import { Sidebar } from './sidebar/sidebar';
import { TabBar } from './tab-bar/tab-bar';
import { inBackground } from './core/background';

interface Problem {
  text: string;
  /** null: the problem lasts until its cause is gone */
  dismiss: (() => void) | null;
}

@Component({
  selector: 'wl-root',
  imports: [AgentSheetView, Sidebar, TabBar, Pane, TourOverlay],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-root', '(document:keydown)': 'hotkeys.handle($event)' },
})
export class App implements OnInit {
  protected readonly store = inject(WorklogStore);
  private readonly profiles = inject(ProfileStore);
  private readonly live = inject(LiveUpdates);
  private readonly updates = inject(UpdateStore);
  protected readonly tabs = inject(TabsStore);
  protected readonly hotkeys = inject(Hotkeys);
  protected readonly agentSheet = inject(AgentSheet);
  private readonly tour = inject(Tour);

  /** the window under the tour's dim takes no keyboard focus either */
  protected readonly touring = computed(() => this.tour.current() !== null);

  protected readonly problem = computed<Problem | null>(() => {
    if (!this.live.connected()) return { text: NO_CONNECTION, dismiss: null };
    const loadError = this.store.loadError();
    if (loadError !== null) return { text: loadError, dismiss: null };
    const actionError = this.store.actionError();
    if (actionError !== null) return { text: actionError, dismiss: () => this.store.dismissProblem() };
    const updateFailure = this.updates.failure();
    return updateFailure === null ? null : { text: updateFailure, dismiss: () => inBackground(this.updates.dismiss()) };
  });

  constructor() {
    // EMPTY_STATE is the placeholder before the first load
    effect(() => {
      if (this.store.state() !== EMPTY_STATE) untracked(() => this.tour.autoStart());
    });
  }

  ngOnInit(): void {
    inBackground(this.profiles.load());
    inBackground(this.store.refresh());
    inBackground(this.updates.load());
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
