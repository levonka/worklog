import { moveInList } from '@worklog/model';

const FIXED_TABS = ['board', 'todos', 'daily', 'history', 'done', 'knowledge'] as const;
export type FixedTab = (typeof FIXED_TABS)[number];
export type TabId = FixedTab | `direction:${string}`;

export interface Layout {
  tabs: TabId[];
  active: TabId | null;
  split: TabId | null;
  ratio: number;
}

export const DEFAULT_LAYOUT: Layout = { tabs: ['board', 'todos'], active: 'board', split: 'todos', ratio: 0.62 };

const DIRECTION_PREFIX = 'direction:';
const MIN_RATIO = 0.25;
const MAX_RATIO = 0.75;

export function isTabId(value: unknown): value is TabId {
  return FIXED_TABS.some(tab => tab === value) || (typeof value === 'string' && value.startsWith(DIRECTION_PREFIX) && value.length > DIRECTION_PREFIX.length);
}

export function directionIdOf(id: TabId): string | null {
  return id.startsWith(DIRECTION_PREFIX) ? id.slice(DIRECTION_PREFIX.length) : null;
}

export function openTab(l: Layout, id: TabId): Layout {
  if (id === l.split || (id === l.active && l.tabs.includes(id))) return l;
  return { ...l, tabs: l.tabs.includes(id) ? l.tabs : [...l.tabs, id], active: id };
}

export function closeTab(l: Layout, id: TabId): Layout {
  const index = l.tabs.indexOf(id);
  if (index < 0) return l;
  const tabs = l.tabs.filter(tab => tab !== id);
  const split = l.split === id ? null : l.split;
  const active = l.active === id ? neighbourOf(tabs, index, split) : l.active;
  // as in Split View, the right pane never stays alone: its tab takes the whole window
  if (active === null && split !== null) return { ...l, tabs, active: split, split: null };
  return { ...l, tabs, active, split };
}

export function splitRight(l: Layout, id: TabId): Layout {
  if (!l.tabs.includes(id) || l.split === id) return l;
  if (l.active !== null && l.active !== id) return { ...l, split: id };
  const other = l.tabs.find(tab => tab !== id);
  // no other tab could fill the left pane
  if (other === undefined) return l;
  return { ...l, active: other, split: id };
}

export function unsplit(l: Layout): Layout {
  return l.split === null ? l : { ...l, split: null };
}

export function reorderTabs(l: Layout, from: number, to: number): Layout {
  const target = Math.max(0, Math.min(to, l.tabs.length - 1));
  if (from < 0 || from >= l.tabs.length || from === target) return l;
  return { ...l, tabs: moveInList(l.tabs, from, target) };
}

export function setRatio(l: Layout, r: number): Layout {
  const ratio = Math.max(MIN_RATIO, Math.min(r, MAX_RATIO));
  return ratio === l.ratio ? l : { ...l, ratio };
}

export function sanitize(l: Layout, directionIds: ReadonlySet<string>): Layout {
  const missing = l.tabs.filter(tab => {
    const directionId = directionIdOf(tab);
    return directionId !== null && !directionIds.has(directionId);
  });
  return missing.reduce((layout, tab) => closeTab(layout, tab), l);
}

// `index` is where the closed tab stood: tabs[index] is now its right neighbour
function neighbourOf(tabs: TabId[], index: number, split: TabId | null): TabId | null {
  const right = tabs.slice(index).find(tab => tab !== split);
  return right ?? tabs.slice(0, index).reverse().find(tab => tab !== split) ?? null;
}
