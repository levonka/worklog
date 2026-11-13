import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { Direction, WorklogState } from '@worklog/model';
import { DEFAULT_LAYOUT } from './tabs-layout';
import { TabsStore } from './tabs-store';
import { WorklogStore } from './worklog-store';

const STORAGE_KEY = 'worklog.layout.v1';
const CREATED_AT = '2026-11-01T09:00:00.000Z';

function direction(id: string): Direction {
  return { id, title: `Направление ${id}`, status: 'waiting', tickets: [], links: [], events: [], order: 0, createdAt: CREATED_AT, updatedAt: CREATED_AT };
}

function saved(): unknown {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
}

describe('TabsStore', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    try {
      http.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  async function loadState(state: WorklogState): Promise<void> {
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(state);
    await loading;
    TestBed.tick();
  }

  it('restores the saved layout and sidebar state', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs: ['todos', 'direction:a'], active: 'direction:a', split: null, ratio: 0.5, sidebarHidden: true }));

    const tabs = TestBed.inject(TabsStore);

    expect(tabs.layout()).toEqual({ tabs: ['todos', 'direction:a'], active: 'direction:a', split: null, ratio: 0.5 });
    expect(tabs.sidebarHidden()).toBe(true);
  });

  it.each([
    ['nothing saved', null],
    ['broken JSON', '{"tabs":'],
    ['tabs not a list', '{"tabs":"board","active":"board","split":null,"ratio":0.5}'],
    ['unknown tab', '{"tabs":["board","calendar"],"active":"board","split":null,"ratio":0.5}'],
    ['active tab not open', '{"tabs":["board"],"active":"todos","split":null,"ratio":0.5}'],
    ['same tab in both panes', '{"tabs":["board"],"active":"board","split":"board","ratio":0.5}'],
    ['right pane without a left one', '{"tabs":["todos"],"active":null,"split":"todos","ratio":0.5}'],
    ['ratio out of range', '{"tabs":["board"],"active":"board","split":null,"ratio":2}'],
  ])('starts with the default layout when %s', (_case, raw) => {
    if (raw !== null) localStorage.setItem(STORAGE_KEY, raw);

    const tabs = TestBed.inject(TabsStore);

    expect(tabs.layout()).toEqual(DEFAULT_LAYOUT);
    expect(tabs.sidebarHidden()).toBe(false);
  });

  it('starts with the default layout and keeps working when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    const tabs = TestBed.inject(TabsStore);
    tabs.openTab('direction:a');

    expect(tabs.layout()).toEqual({ ...DEFAULT_LAYOUT, tabs: ['board', 'todos', 'direction:a'], active: 'direction:a' });
  });

  it('saves every change together with the sidebar state', () => {
    const tabs = TestBed.inject(TabsStore);

    tabs.openTab('direction:a');
    expect(saved()).toEqual({ tabs: ['board', 'todos', 'direction:a'], active: 'direction:a', split: 'todos', ratio: 0.62, sidebarHidden: false });

    tabs.splitRight('direction:a');
    tabs.setRatio(0.4);
    tabs.toggleSidebar();
    expect(saved()).toEqual({ tabs: ['board', 'todos', 'direction:a'], active: 'board', split: 'direction:a', ratio: 0.4, sidebarHidden: true });

    tabs.reorderTabs(2, 0);
    tabs.closeTab('board');
    tabs.unsplit();
    expect(saved()).toEqual({ tabs: ['direction:a', 'todos'], active: 'todos', split: null, ratio: 0.4, sidebarHidden: true });
  });

  it('replaceLayout puts a layout taken earlier back and saves it', () => {
    const tabs = TestBed.inject(TabsStore);
    const before = tabs.layout();
    tabs.openTab('daily');
    tabs.openTab('direction:a');

    tabs.replaceLayout(before);

    expect(tabs.layout()).toEqual(before);
    expect(saved()).toEqual({ ...before, sidebarHidden: false });
  });

  it('replaceLayout drops tabs of directions deleted since the layout was taken', async () => {
    const tabs = TestBed.inject(TabsStore);
    await loadState({ directions: [direction('a')], todos: [], repeats: [], linkGroups: [], dailies: [], draft: null, notes: [], runs: [] });

    tabs.replaceLayout({ tabs: ['board', 'direction:a', 'direction:gone'], active: 'direction:gone', split: 'direction:a', ratio: 0.5 });

    expect(tabs.layout()).toEqual({ tabs: ['board', 'direction:a'], active: 'board', split: 'direction:a', ratio: 0.5 });
  });

  it('drops tabs of deleted directions once the state has loaded, not before', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs: ['board', 'direction:a', 'direction:b'], active: 'direction:b', split: 'direction:a', ratio: 0.5 }));
    const tabs = TestBed.inject(TabsStore);

    TestBed.tick();
    expect(tabs.layout().tabs).toEqual(['board', 'direction:a', 'direction:b']);

    await loadState({ directions: [direction('a')], todos: [], repeats: [], linkGroups: [], dailies: [], draft: null, notes: [], runs: [] });

    expect(tabs.layout()).toEqual({ tabs: ['board', 'direction:a'], active: 'board', split: 'direction:a', ratio: 0.5 });
    expect(saved()).toEqual({ tabs: ['board', 'direction:a'], active: 'board', split: 'direction:a', ratio: 0.5, sidebarHidden: false });
  });

  it('describes tabs by their content', async () => {
    const tabs = TestBed.inject(TabsStore);
    await loadState({ directions: [direction('a')], todos: [], repeats: [], linkGroups: [], dailies: [], draft: null, notes: [], runs: [] });

    expect(tabs.view('board')).toEqual({ title: 'Доска', icon: '▦', status: null });
    expect(tabs.view('todos')).toEqual({ title: 'Дела', icon: '☑︎', status: null });
    expect(tabs.view('direction:a')).toEqual({ title: 'Направление a', icon: null, status: 'waiting' });
  });

  it('closes the focused tab: the one in the pane used last, else the left one', async () => {
    const tabs = TestBed.inject(TabsStore);
    await loadState({ directions: [direction('a')], todos: [], repeats: [], linkGroups: [], dailies: [], draft: null, notes: [], runs: [] });
    tabs.openTab('direction:a');

    tabs.closeFocused();
    expect(tabs.layout()).toMatchObject({ tabs: ['board', 'todos'], active: 'board', split: 'todos' });

    tabs.focus('todos');
    tabs.closeFocused();
    expect(tabs.layout()).toMatchObject({ tabs: ['board'], active: 'board', split: null });

    tabs.focus('todos');
    tabs.closeFocused();
    expect(tabs.layout()).toMatchObject({ tabs: [], active: null });

    tabs.closeFocused();
    expect(tabs.layout().tabs).toEqual([]);
  });

  it('reopens closed tabs newest first, skipping open tabs and deleted directions', async () => {
    const tabs = TestBed.inject(TabsStore);
    await loadState({ directions: [direction('a'), direction('b')], todos: [], repeats: [], linkGroups: [], dailies: [], draft: null, notes: [], runs: [] });
    tabs.openTab('direction:a');
    tabs.openTab('direction:b');
    tabs.closeTab('direction:a');
    tabs.closeTab('board');
    tabs.closeTab('direction:b');
    tabs.openTab('board');
    await loadState({ directions: [direction('a')], todos: [], repeats: [], linkGroups: [], dailies: [], draft: null, notes: [], runs: [] });

    tabs.reopenClosed();
    expect(tabs.layout()).toMatchObject({ tabs: ['todos', 'board', 'direction:a'], active: 'direction:a' });

    tabs.reopenClosed();
    expect(tabs.layout().tabs).toEqual(['todos', 'board', 'direction:a']);
  });

  it('selects a tab by its number, the last one for 9', async () => {
    const tabs = TestBed.inject(TabsStore);
    await loadState({ directions: [direction('a'), direction('b')], todos: [], repeats: [], linkGroups: [], dailies: [], draft: null, notes: [], runs: [] });
    tabs.openTab('direction:a');
    tabs.openTab('direction:b');

    tabs.selectTab(0);
    expect(tabs.layout().active).toBe('board');
    tabs.selectTab(-1);
    expect(tabs.layout().active).toBe('direction:b');
    tabs.selectTab(7);
    expect(tabs.layout().active).toBe('direction:b');

    tabs.selectTab(1);
    expect(tabs.layout().active).toBe('direction:b');
    expect(tabs.focusedTab()).toBe('todos');
  });

  it('steps to the next and previous tab from the focused one, wrapping around', async () => {
    const tabs = TestBed.inject(TabsStore);
    await loadState({ directions: [direction('a')], todos: [], repeats: [], linkGroups: [], dailies: [], draft: null, notes: [], runs: [] });
    tabs.openTab('direction:a');
    tabs.unsplit();

    tabs.stepTab(1);
    expect(tabs.layout().active).toBe('board');
    tabs.stepTab(-1);
    expect(tabs.layout().active).toBe('direction:a');
    tabs.stepTab(-1);
    expect(tabs.layout().active).toBe('todos');
  });

  it('steps into the right pane and on from there', async () => {
    const tabs = TestBed.inject(TabsStore);
    await loadState({ directions: [direction('a')], todos: [], repeats: [], linkGroups: [], dailies: [], draft: null, notes: [], runs: [] });
    tabs.openTab('direction:a');
    tabs.selectTab(0);

    tabs.stepTab(1);
    expect(tabs.layout()).toMatchObject({ active: 'board', split: 'todos' });
    expect(tabs.focusedTab()).toBe('todos');

    tabs.stepTab(1);
    expect(tabs.layout()).toMatchObject({ active: 'direction:a', split: 'todos' });
    expect(tabs.focusedTab()).toBe('direction:a');
  });
});
