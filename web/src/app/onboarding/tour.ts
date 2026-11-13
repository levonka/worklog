import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { BOARD_STATUSES, EMPTY_STATE, isExample } from '@worklog/model';
import type { Direction } from '@worklog/model';
import { inBackground } from '../core/background';
import type { Layout, TabId } from '../core/tabs-layout';
import { TabsStore } from '../core/tabs-store';
import { WorklogStore } from '../core/worklog-store';
import type { TourStep, TourStepId } from './tour-steps';
import { DIRECTION_STEPS, TOUR_STEPS, tourStep } from './tour-steps';

export interface TourView {
  step: TourStep;
  index: number;
  total: number;
  /** one bubble asked for by «Показать»: no navigation */
  single: boolean;
}

interface Run {
  steps: readonly TourStep[];
  index: number;
  single: boolean;
  directionId: string | null;
  /** the layout before the tour, put back at its end; a single bubble leaves the layout as it is */
  layout: Layout | null;
}

@Injectable({ providedIn: 'root' })
export class Tour {
  private readonly worklog = inject(WorklogStore);
  private readonly tabs = inject(TabsStore);

  private readonly run = signal<Run | null>(null);
  // a step skipped for want of its target is passed in the direction of the last move
  private lastMove: 1 | -1 = 1;
  private autoStarted = false;

  readonly current = computed<TourView | null>(() => {
    const run = this.run();
    return run === null ? null : { step: run.steps[run.index], index: run.index, total: run.steps.length, single: run.single };
  });
  readonly directionId = computed(() => this.run()?.directionId ?? null);

  constructor() {
    // its tab is closed by TabsStore; the steps about it lose their target and are skipped
    effect(() => {
      const state = this.worklog.state();
      untracked(() => {
        const run = this.run();
        if (run === null || run.directionId === null || state === EMPTY_STATE) return;
        if (!state.directions.some(direction => direction.id === run.directionId)) this.run.set({ ...run, directionId: null });
      });
    });
  }

  start(): void {
    const running = this.run();
    // a restart in the middle keeps the layout from before the first start
    const layout = running?.layout ?? this.tabs.layout();
    const directionId = this.boardDirection()?.id ?? null;
    const steps = TOUR_STEPS.filter(step => directionId !== null || !DIRECTION_STEPS.includes(step.id));
    this.lastMove = 1;
    this.tabs.pauseSaving(true);
    this.go({ steps, index: 0, single: false, directionId, layout });
  }

  show(id: TourStepId): void {
    if (this.run()?.single === false) return;
    const own = this.worklog.ownDirections().find(direction => direction.status !== 'done');
    const directionId = (own ?? this.worklog.state().directions.find(isExample))?.id ?? null;
    this.lastMove = 1;
    this.go({ steps: [tourStep(id)], index: 0, single: true, directionId, layout: null });
  }

  next(): void {
    const run = this.run();
    if (run === null) return;
    this.lastMove = 1;
    if (run.single || run.index + 1 >= run.steps.length) this.close();
    else this.go({ ...run, index: run.index + 1 });
  }

  back(): void {
    const run = this.run();
    if (run === null || run.single || run.index === 0) return;
    this.lastMove = -1;
    this.go({ ...run, index: run.index - 1 });
  }

  skip(): void {
    const run = this.run();
    if (run === null) return;
    if (this.lastMove < 0 && run.index > 0) this.back();
    else this.next();
  }

  close(): void {
    const run = this.run();
    if (run === null) return;
    this.run.set(null);
    if (run.single) return;
    inBackground(this.worklog.setOnboarding({ tourClosed: true }));
    this.tabs.pauseSaving(false);
    if (run.layout !== null) this.tabs.replaceLayout(run.layout);
  }

  /** the first time the window shows loaded data, unless the tour was finished or closed before */
  autoStart(): void {
    if (this.autoStarted || this.worklog.state() === EMPTY_STATE) return;
    this.autoStarted = true;
    if (this.worklog.onboarding().tourClosedAt === undefined) this.start();
  }

  /** the example when it is on the board, else the first own direction there */
  private boardDirection(): Direction | undefined {
    const columns = this.worklog.columns();
    const onBoard = BOARD_STATUSES.flatMap(status => columns[status]);
    return onBoard.find(isExample) ?? onBoard[0];
  }

  private go(run: Run): void {
    this.run.set(run);
    this.openScreen(run.steps[run.index], run.directionId);
  }

  private openScreen(step: TourStep, directionId: string | null): void {
    switch (step.screen) {
      case null:
        if (step.target === 'sidebar-tabs' && this.tabs.sidebarHidden()) this.tabs.toggleSidebar();
        return;
      case 'board':
        if (step.demo === 'todo-card') this.sideBySide('board', 'todos');
        else this.tabs.openTab('board');
        return;
      case 'direction':
        if (directionId !== null) this.tabs.openTab(`direction:${directionId}`);
        return;
      default:
        this.tabs.openTab(step.screen);
    }
  }

  private sideBySide(left: TabId, right: TabId): void {
    // already in the right pane: it stays there, the other one takes the left
    if (this.tabs.layout().split === left) {
      this.tabs.openTab(right);
      return;
    }
    this.tabs.openTab(right);
    this.tabs.openTab(left);
    this.tabs.splitRight(right);
  }
}
