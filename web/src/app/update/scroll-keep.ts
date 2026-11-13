import type { TabId } from '../core/tabs-layout';

const SCROLL_KEY = 'worklog.scroll.v1';

/** the scroll of every open pane, for the window a reload brings back */
export function saveScroll(doc: Document, storage: Storage): void {
  const scroll: Record<string, number> = {};
  for (const pane of doc.querySelectorAll('wl-pane[data-tab-id]')) {
    const id = pane.getAttribute('data-tab-id');
    const body = pane.querySelector('.pn__body');
    if (id !== null && body !== null) scroll[id] = body.scrollTop;
  }
  storage.setItem(SCROLL_KEY, JSON.stringify(scroll));
}

/** the saved scroll of a pane, given once */
export function takeScroll(storage: Storage, tabId: TabId): number | null {
  const scroll = readScroll(storage);
  const top = scroll.get(tabId);
  if (top === undefined) return null;
  scroll.delete(tabId);
  storage.setItem(SCROLL_KEY, JSON.stringify(Object.fromEntries(scroll)));
  return top;
}

function readScroll(storage: Storage): Map<string, number> {
  // broken JSON: nothing to restore
  try {
    const raw: unknown = JSON.parse(storage.getItem(SCROLL_KEY) ?? '{}');
    if (typeof raw !== 'object' || raw === null) return new Map();
    return new Map(Object.entries(raw).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
  } catch {
    return new Map();
  }
}
