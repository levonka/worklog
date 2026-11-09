import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { Hotkey } from './hotkeys';
import { Hotkeys, hotkeyOf } from './hotkeys';
import { TabsStore } from './tabs-store';
import { WorklogStore } from './worklog-store';

function key(code: string, mods: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...mods });
}

describe('hotkeyOf', () => {
  const cases: { name: string; event: KeyboardEvent; hotkey: Hotkey | null }[] = [
    { name: '⌘W', event: key('KeyW', { metaKey: true }), hotkey: { kind: 'close-tab' } },
    { name: '⌘⇧T', event: key('KeyT', { metaKey: true, shiftKey: true }), hotkey: { kind: 'reopen-tab' } },
    { name: '⌘Z', event: key('KeyZ', { metaKey: true }), hotkey: { kind: 'undo' } },
    { name: '⌘⇧Z', event: key('KeyZ', { metaKey: true, shiftKey: true }), hotkey: { kind: 'redo' } },
    { name: '⌘1', event: key('Digit1', { metaKey: true }), hotkey: { kind: 'select-tab', index: 0 } },
    { name: '⌘8', event: key('Digit8', { metaKey: true }), hotkey: { kind: 'select-tab', index: 7 } },
    { name: '⌘9', event: key('Digit9', { metaKey: true }), hotkey: { kind: 'select-tab', index: -1 } },
    { name: '⌘⇧]', event: key('BracketRight', { metaKey: true, shiftKey: true }), hotkey: { kind: 'step-tab', delta: 1 } },
    { name: '⌘⇧[', event: key('BracketLeft', { metaKey: true, shiftKey: true }), hotkey: { kind: 'step-tab', delta: -1 } },
    { name: '⌃Tab', event: key('Tab', { ctrlKey: true }), hotkey: { kind: 'step-tab', delta: 1 } },
    { name: '⌃⇧Tab', event: key('Tab', { ctrlKey: true, shiftKey: true }), hotkey: { kind: 'step-tab', delta: -1 } },
    { name: 'plain W', event: key('KeyW'), hotkey: null },
    { name: '⌘⇧W', event: key('KeyW', { metaKey: true, shiftKey: true }), hotkey: null },
    { name: '⌘⌥W', event: key('KeyW', { metaKey: true, altKey: true }), hotkey: null },
    { name: '⌃W', event: key('KeyW', { ctrlKey: true }), hotkey: null },
    { name: '⌘T', event: key('KeyT', { metaKey: true }), hotkey: null },
    { name: '⌘0', event: key('Digit0', { metaKey: true }), hotkey: null },
    { name: '⌘]', event: key('BracketRight', { metaKey: true }), hotkey: null },
    { name: 'Tab', event: key('Tab'), hotkey: null },
    { name: '⌘Tab', event: key('Tab', { metaKey: true }), hotkey: null },
  ];

  it.each(cases)('$name', ({ event, hotkey }) => {
    expect(hotkeyOf(event)).toEqual(hotkey);
  });

  it('goes by the key position, so the Russian layout works too', () => {
    expect(hotkeyOf(new KeyboardEvent('keydown', { code: 'KeyW', key: 'ц', metaKey: true }))).toEqual({ kind: 'close-tab' });
  });
});

describe('Hotkeys', () => {
  let hotkeys: Hotkeys;
  let tabs: TabsStore;
  let worklog: WorklogStore;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    hotkeys = TestBed.inject(Hotkeys);
    tabs = TestBed.inject(TabsStore);
    worklog = TestBed.inject(WorklogStore);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  function press(event: KeyboardEvent, target: Element = document.body): KeyboardEvent {
    target.dispatchEvent(event);
    hotkeys.handle(event);
    return event;
  }

  it('⌘W closes the focused tab and keeps the window open', () => {
    const close = vi.spyOn(tabs, 'closeFocused');
    expect(press(key('KeyW', { metaKey: true })).defaultPrevented).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it('runs the tab commands', () => {
    const reopen = vi.spyOn(tabs, 'reopenClosed');
    const select = vi.spyOn(tabs, 'selectTab');
    const step = vi.spyOn(tabs, 'stepTab');

    press(key('KeyT', { metaKey: true, shiftKey: true }));
    press(key('Digit9', { metaKey: true }));
    press(key('Tab', { ctrlKey: true, shiftKey: true }));

    expect(reopen).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledWith(-1);
    expect(step).toHaveBeenCalledWith(-1);
  });

  it('⌘Z and ⌘⇧Z undo and redo data changes', () => {
    const undo = vi.spyOn(worklog, 'undo').mockResolvedValue();
    const redo = vi.spyOn(worklog, 'redo').mockResolvedValue();

    expect(press(key('KeyZ', { metaKey: true })).defaultPrevented).toBe(true);
    press(key('KeyZ', { metaKey: true, shiftKey: true }));

    expect(undo).toHaveBeenCalledOnce();
    expect(redo).toHaveBeenCalledOnce();
  });

  it('leaves ⌘Z to a text field, but not to a checkbox', () => {
    const undo = vi.spyOn(worklog, 'undo').mockResolvedValue();
    const field = document.createElement('input');
    const area = document.createElement('textarea');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    document.body.append(field, area, checkbox);

    expect(press(key('KeyZ', { metaKey: true }), field).defaultPrevented).toBe(false);
    expect(press(key('KeyZ', { metaKey: true, shiftKey: true }), area).defaultPrevented).toBe(false);
    expect(undo).not.toHaveBeenCalled();

    press(key('KeyZ', { metaKey: true }), checkbox);
    expect(undo).toHaveBeenCalledOnce();
  });

  it('⌘W works from a text field too', () => {
    const close = vi.spyOn(tabs, 'closeFocused');
    const field = document.createElement('input');
    document.body.append(field);

    press(key('KeyW', { metaKey: true }), field);
    expect(close).toHaveBeenCalledOnce();
  });

  it('ignores other keys and events already handled', () => {
    const close = vi.spyOn(tabs, 'closeFocused');
    expect(press(key('KeyW')).defaultPrevented).toBe(false);

    const handled = key('KeyW', { metaKey: true });
    handled.preventDefault();
    press(handled);

    expect(close).not.toHaveBeenCalled();
  });
});
