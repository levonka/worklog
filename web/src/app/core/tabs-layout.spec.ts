import type { Layout } from './tabs-layout';
import { closeTab, DEFAULT_LAYOUT, isTabId, openTab, reorderTabs, sanitize, setRatio, splitRight, unsplit } from './tabs-layout';

const FOUR_TABS: Layout = { tabs: ['board', 'todos', 'direction:a', 'direction:b'], active: 'direction:a', split: 'todos', ratio: 0.5 };

describe('tabs layout', () => {
  it('default layout shows the board with todos on the right', () => {
    expect(DEFAULT_LAYOUT).toEqual({ tabs: ['board', 'todos'], active: 'board', split: 'todos', ratio: 0.62 });
  });

  it('openTab appends a missing tab, activates an open one and leaves the split tab alone', () => {
    const opened = openTab(DEFAULT_LAYOUT, 'direction:a');
    expect(opened).toEqual({ tabs: ['board', 'todos', 'direction:a'], active: 'direction:a', split: 'todos', ratio: 0.62 });
    expect(openTab(opened, 'board')).toEqual({ tabs: ['board', 'todos', 'direction:a'], active: 'board', split: 'todos', ratio: 0.62 });
    expect(openTab(opened, 'todos')).toBe(opened);
  });

  it('closeTab activates the right neighbour, else the left one, skipping the split tab', () => {
    expect(closeTab(FOUR_TABS, 'direction:a')).toEqual({ tabs: ['board', 'todos', 'direction:b'], active: 'direction:b', split: 'todos', ratio: 0.5 });
    expect(closeTab({ ...FOUR_TABS, active: 'direction:b' }, 'direction:b')).toEqual({
      tabs: ['board', 'todos', 'direction:a'],
      active: 'direction:a',
      split: 'todos',
      ratio: 0.5,
    });
    expect(closeTab({ tabs: ['board', 'todos', 'direction:a'], active: 'direction:a', split: 'todos', ratio: 0.5 }, 'direction:a')).toEqual({
      tabs: ['board', 'todos'],
      active: 'board',
      split: 'todos',
      ratio: 0.5,
    });
    expect(closeTab({ tabs: ['direction:a', 'todos', 'board'], active: 'direction:a', split: 'todos', ratio: 0.5 }, 'direction:a')).toEqual({
      tabs: ['todos', 'board'],
      active: 'board',
      split: 'todos',
      ratio: 0.5,
    });
    expect(closeTab(FOUR_TABS, 'direction:b')).toEqual({ tabs: ['board', 'todos', 'direction:a'], active: 'direction:a', split: 'todos', ratio: 0.5 });
  });

  it('closing the split tab unsplits', () => {
    expect(closeTab(DEFAULT_LAYOUT, 'todos')).toEqual({ tabs: ['board'], active: 'board', split: null, ratio: 0.62 });
  });

  it('closing the active tab next to a lone split tab moves that tab to the left pane', () => {
    expect(closeTab(DEFAULT_LAYOUT, 'board')).toEqual({ tabs: ['todos'], active: 'todos', split: null, ratio: 0.62 });
    expect(sanitize({ tabs: ['direction:gone', 'todos'], active: 'direction:gone', split: 'todos', ratio: 0.5 }, new Set())).toEqual({
      tabs: ['todos'],
      active: 'todos',
      split: null,
      ratio: 0.5,
    });
  });

  it('closing the last tab leaves no active tab', () => {
    expect(closeTab({ tabs: ['board'], active: 'board', split: null, ratio: 0.62 }, 'board')).toEqual({ tabs: [], active: null, split: null, ratio: 0.62 });
  });

  it('splitRight shows the tab on the right and activates the first other tab when it was active', () => {
    const three: Layout = { tabs: ['board', 'todos', 'direction:a'], active: 'board', split: 'todos', ratio: 0.62 };
    expect(splitRight(three, 'direction:a')).toEqual({ tabs: ['board', 'todos', 'direction:a'], active: 'board', split: 'direction:a', ratio: 0.62 });
    expect(splitRight(three, 'board')).toEqual({ tabs: ['board', 'todos', 'direction:a'], active: 'todos', split: 'board', ratio: 0.62 });
    expect(splitRight(three, 'direction:missing')).toBe(three);
  });

  it('splitRight keeps a tab in the left pane', () => {
    const noActive: Layout = { tabs: ['board', 'todos', 'direction:a'], active: null, split: null, ratio: 0.62 };
    expect(splitRight(noActive, 'direction:a')).toEqual({ tabs: ['board', 'todos', 'direction:a'], active: 'board', split: 'direction:a', ratio: 0.62 });
    const single: Layout = { tabs: ['board'], active: 'board', split: null, ratio: 0.62 };
    expect(splitRight(single, 'board')).toBe(single);
  });

  it('unsplit clears the right pane', () => {
    expect(unsplit(DEFAULT_LAYOUT)).toEqual({ tabs: ['board', 'todos'], active: 'board', split: null, ratio: 0.62 });
  });

  it('reorderTabs moves a tab and keeps the panes', () => {
    expect(reorderTabs(FOUR_TABS, 0, 2)).toEqual({ tabs: ['todos', 'direction:a', 'board', 'direction:b'], active: 'direction:a', split: 'todos', ratio: 0.5 });
    expect(reorderTabs(FOUR_TABS, 3, 0)).toEqual({ tabs: ['direction:b', 'board', 'todos', 'direction:a'], active: 'direction:a', split: 'todos', ratio: 0.5 });
    expect(reorderTabs(FOUR_TABS, 1, 1)).toBe(FOUR_TABS);
  });

  it('setRatio clamps to 0.25..0.75', () => {
    expect(setRatio(DEFAULT_LAYOUT, 0.4)).toEqual({ tabs: ['board', 'todos'], active: 'board', split: 'todos', ratio: 0.4 });
    expect(setRatio(DEFAULT_LAYOUT, 0.1)).toEqual({ tabs: ['board', 'todos'], active: 'board', split: 'todos', ratio: 0.25 });
    expect(setRatio(DEFAULT_LAYOUT, 0.9)).toEqual({ tabs: ['board', 'todos'], active: 'board', split: 'todos', ratio: 0.75 });
  });

  it('sanitize drops tabs of missing directions', () => {
    const saved: Layout = { tabs: ['board', 'direction:gone', 'todos', 'direction:kept'], active: 'direction:gone', split: 'direction:kept', ratio: 0.5 };
    expect(sanitize(saved, new Set(['kept']))).toEqual({ tabs: ['board', 'todos', 'direction:kept'], active: 'todos', split: 'direction:kept', ratio: 0.5 });
    expect(sanitize({ tabs: ['board', 'direction:gone'], active: 'board', split: 'direction:gone', ratio: 0.5 }, new Set())).toEqual({
      tabs: ['board'],
      active: 'board',
      split: null,
      ratio: 0.5,
    });
  });

  it('sanitize returns the same layout when every direction exists', () => {
    expect(sanitize(FOUR_TABS, new Set(['a', 'b']))).toBe(FOUR_TABS);
  });

  it('operations that change nothing return the same layout', () => {
    expect(openTab(FOUR_TABS, 'direction:a')).toBe(FOUR_TABS);
    expect(splitRight(FOUR_TABS, 'todos')).toBe(FOUR_TABS);
    expect(setRatio(FOUR_TABS, 0.5)).toBe(FOUR_TABS);
    expect(setRatio({ ...FOUR_TABS, ratio: 0.75 }, 0.9).ratio).toBe(0.75);
    const single: Layout = { ...FOUR_TABS, split: null };
    expect(unsplit(single)).toBe(single);
    const clamped: Layout = { ...FOUR_TABS, ratio: 0.75 };
    expect(setRatio(clamped, 0.9)).toBe(clamped);
  });

  it('closing the active tab with only the right one left gives it the whole window', () => {
    expect(closeTab({ tabs: ['board', 'todos'], active: 'board', split: 'todos', ratio: 0.5 }, 'board')).toEqual({
      tabs: ['todos'],
      active: 'todos',
      split: null,
      ratio: 0.5,
    });
  });

  it('splitRight with a single tab changes nothing', () => {
    const single: Layout = { tabs: ['board'], active: 'board', split: null, ratio: 0.5 };
    expect(splitRight(single, 'board')).toBe(single);
  });

  it('isTabId accepts daily and history', () => {
    expect(isTabId('daily')).toBe(true);
    expect(isTabId('history')).toBe(true);
    expect(isTabId('dailies')).toBe(false);
  });
});
