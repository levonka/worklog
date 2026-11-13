import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { EMPTY_STATE } from '@worklog/model';
import type { Status } from '@worklog/model';
import type { Layout, TabId } from './tabs-layout';
import { closeTab, DEFAULT_LAYOUT, directionIdOf, isTabId, openTab, reorderTabs, sanitize, setRatio, splitRight, unsplit } from './tabs-layout';
import { WorklogStore } from './worklog-store';

const STORAGE_KEY = 'worklog.layout.v1';
const MAX_CLOSED = 20;

export interface TabView {
  title: string;
  icon: string | null;
  /** the direction's status, for direction tabs */
  status: Status | null;
}

interface Saved {
  layout: Layout;
  sidebarHidden: boolean;
}

@Injectable({ providedIn: 'root' })
export class TabsStore {
  private readonly worklog = inject(WorklogStore);
  private readonly saved = load();
  private readonly currentLayout = signal(this.saved.layout);
  private readonly hidden = signal(this.saved.sidebarHidden);
  private readonly lastFocused = signal<TabId | null>(null);
  private readonly closed: TabId[] = [];

  readonly layout = this.currentLayout.asReadonly();
  readonly sidebarHidden = this.hidden.asReadonly();
  /** the tab of the pane used last, else the left one */
  readonly focusedTab = computed(() => {
    const { active, split } = this.layout();
    const focused = this.lastFocused();
    return focused !== null && (focused === active || focused === split) ? focused : (active ?? split);
  });

  constructor() {
    effect(() => {
      const state = this.worklog.state();
      // EMPTY_STATE is the placeholder before the first load: sanitizing against it would close every direction tab
      if (state === EMPTY_STATE) return;
      const directionIds = new Set(state.directions.map(direction => direction.id));
      untracked(() => this.apply(layout => sanitize(layout, directionIds)));
    });
  }

  // the split tab stays in the right pane: opening it focuses that pane
  openTab(id: TabId): void {
    this.apply(layout => openTab(layout, id));
    this.lastFocused.set(id);
  }

  focus(id: TabId): void {
    this.lastFocused.set(id);
  }

  /** puts back a layout taken earlier, as the tour does when it ends */
  replaceLayout(layout: Layout): void {
    this.apply(() => layout);
  }

  closeTab(id: TabId): void {
    if (!this.layout().tabs.includes(id)) return;
    const earlier = this.closed.indexOf(id);
    if (earlier >= 0) this.closed.splice(earlier, 1);
    this.closed.push(id);
    if (this.closed.length > MAX_CLOSED) this.closed.shift();
    this.apply(layout => closeTab(layout, id));
  }

  closeFocused(): void {
    const id = this.focusedTab();
    if (id !== null) this.closeTab(id);
  }

  reopenClosed(): void {
    for (let id = this.closed.pop(); id !== undefined; id = this.closed.pop()) {
      if (this.layout().tabs.includes(id)) continue;
      const directionId = directionIdOf(id);
      if (directionId !== null && this.worklog.directionById(directionId) === undefined) continue;
      this.openTab(id);
      return;
    }
  }

  /** -1 selects the last tab */
  selectTab(index: number): void {
    const id = this.layout().tabs.at(index);
    if (id !== undefined) this.openTab(id);
  }

  stepTab(delta: 1 | -1): void {
    const { tabs } = this.layout();
    if (tabs.length === 0) return;
    const focused = this.focusedTab();
    const from = focused === null ? -1 : tabs.indexOf(focused);
    const to = from < 0 ? (delta > 0 ? 0 : tabs.length - 1) : (from + delta + tabs.length) % tabs.length;
    this.openTab(tabs[to]);
  }

  splitRight(id: TabId): void {
    this.apply(layout => splitRight(layout, id));
    if (this.layout().split === id) this.lastFocused.set(id);
  }

  unsplit(): void {
    this.apply(unsplit);
  }

  reorderTabs(from: number, to: number): void {
    this.apply(layout => reorderTabs(layout, from, to));
  }

  setRatio(ratio: number): void {
    this.apply(layout => setRatio(layout, ratio));
  }

  toggleSidebar(): void {
    this.hidden.update(hidden => !hidden);
    this.save();
  }

  view(id: TabId): TabView {
    if (id === 'board') return { title: 'Доска', icon: '▦', status: null };
    if (id === 'todos') return { title: 'Дела', icon: '☑︎', status: null };
    if (id === 'daily') return { title: 'Дейлик', icon: '🗒︎', status: null };
    if (id === 'history') return { title: 'История', icon: '🕘︎', status: null };
    if (id === 'done') return { title: 'Сделано', icon: '✓︎', status: null };
    if (id === 'knowledge') return { title: 'Знания', icon: '📖︎', status: null };
    const directionId = directionIdOf(id);
    const direction = directionId === null ? undefined : this.worklog.directionById(directionId);
    return {
      title: direction?.title ?? 'Направление',
      icon: null,
      status: direction?.status ?? null,
    };
  }

  private apply(change: (layout: Layout) => Layout): void {
    const next = change(this.currentLayout());
    if (next === this.currentLayout()) return;
    this.currentLayout.set(next);
    this.save();
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...this.currentLayout(), sidebarHidden: this.hidden() }));
    } catch {
      // storage unavailable: the layout lives only until the window closes
    }
  }
}

function load(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const saved = raw === null ? null : parseSaved(JSON.parse(raw));
    if (saved !== null) return saved;
  } catch {
    // unreadable storage or broken JSON: start from the default
  }
  return { layout: DEFAULT_LAYOUT, sidebarHidden: false };
}

function parseSaved(value: unknown): Saved | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!('tabs' in value) || !('active' in value) || !('split' in value) || !('ratio' in value)) return null;
  const { tabs, active, split, ratio } = value;
  if (!Array.isArray(tabs) || !tabs.every(isTabId) || new Set(tabs).size !== tabs.length) return null;
  if (!isOpenOrNull(active, tabs) || !isOpenOrNull(split, tabs)) return null;
  // a tab is shown in at most one pane, and the right pane needs a left one
  if (active === null ? split !== null : active === split) return null;
  if (typeof ratio !== 'number' || setRatio(DEFAULT_LAYOUT, ratio).ratio !== ratio) return null;
  const sidebarHidden = 'sidebarHidden' in value && value.sidebarHidden === true;
  return { layout: { tabs, active, split, ratio }, sidebarHidden };
}

function isOpenOrNull(value: unknown, tabs: readonly TabId[]): value is TabId | null {
  return value === null || (isTabId(value) && tabs.includes(value));
}
