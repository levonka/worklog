import type { TabId } from '../core/tabs-layout';

const SCROLL_KEY = 'worklog.scroll.v1';
// a reload takes seconds: a pane that was not back by then is no longer the one that was saved
export const SCROLL_KEEP_MS = 60_000;

/** a scrolled block of a pane: which one, then how far down and across */
export type Scrolled = [key: string, top: number, left: number];

// each view scrolls its own blocks; the same block after the reload: its tag, its classes and which one of the same it is
function blocks(pane: Element): [string, Element][] {
  const seen = new Map<string, number>();
  return Array.from(pane.querySelectorAll('*'), element => {
    const name = [element.tagName.toLowerCase(), ...element.classList].join('.');
    const index = seen.get(name) ?? 0;
    seen.set(name, index + 1);
    return [`${name}#${index}`, element];
  });
}

/** the scroll of every open pane, for the window a reload brings back */
export function saveScroll(doc: Document, storage: Storage): void {
  const scroll: Record<string, Scrolled[]> = {};
  for (const pane of doc.querySelectorAll('wl-pane[data-tab-id]')) {
    const id = pane.getAttribute('data-tab-id');
    const scrolled = blocks(pane)
      .filter(([, element]) => element.scrollTop > 0 || element.scrollLeft > 0)
      .map(([key, element]): Scrolled => [key, element.scrollTop, element.scrollLeft]);
    if (id !== null && scrolled.length > 0) scroll[id] = scrolled;
  }
  storage.setItem(SCROLL_KEY, JSON.stringify({ savedAt: Date.now(), panes: scroll }));
}

/** the saved scroll of a pane, given once and only soon after the save */
export function takeScroll(storage: Storage, tabId: TabId): Scrolled[] | null {
  const saved = readScroll(storage);
  if (saved === null) {
    storage.removeItem(SCROLL_KEY);
    return null;
  }
  const scrolled = saved.panes.get(tabId);
  if (scrolled === undefined) return null;
  saved.panes.delete(tabId);
  storage.setItem(SCROLL_KEY, JSON.stringify({ savedAt: saved.savedAt, panes: Object.fromEntries(saved.panes) }));
  return scrolled;
}

export function restoreScroll(pane: Element, scrolled: Scrolled[]): void {
  const found = new Map(blocks(pane));
  for (const [key, top, left] of scrolled) {
    const element = found.get(key);
    if (element === undefined) continue;
    element.scrollTop = top;
    element.scrollLeft = left;
  }
}

function isScrolled(value: unknown): value is Scrolled {
  return Array.isArray(value) && value.length === 3 && typeof value[0] === 'string' && typeof value[1] === 'number' && typeof value[2] === 'number';
}

// null: nothing saved, saved too long ago, or unreadable
function readScroll(storage: Storage): { savedAt: number; panes: Map<string, Scrolled[]> } | null {
  try {
    const raw: unknown = JSON.parse(storage.getItem(SCROLL_KEY) ?? 'null');
    if (typeof raw !== 'object' || raw === null || !('savedAt' in raw) || !('panes' in raw)) return null;
    const { savedAt, panes } = raw;
    if (typeof savedAt !== 'number' || Date.now() - savedAt > SCROLL_KEEP_MS || typeof panes !== 'object' || panes === null) return null;
    return { savedAt, panes: new Map(Object.entries(panes).filter((entry): entry is [string, Scrolled[]] => Array.isArray(entry[1]) && entry[1].every(isScrolled))) };
  } catch {
    return null;
  }
}
