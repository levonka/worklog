import { inject, Injectable } from '@angular/core';
import { TabsStore } from './tabs-store';
import { WorklogStore } from './worklog-store';
import { inBackground } from './background';

export type Hotkey =
  | { kind: 'close-tab' }
  | { kind: 'reopen-tab' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  /** -1 is the last tab */
  | { kind: 'select-tab'; index: number }
  | { kind: 'step-tab'; delta: 1 | -1 };

const DIGIT_CODE = /^Digit([1-9])$/;
const LAST_DIGIT = 9;
const NON_TEXT_INPUTS = ['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit'];

// by event.code, the key's position: event.key is 'ц' for ⌘W in the Russian layout
export function hotkeyOf(event: KeyboardEvent): Hotkey | null {
  const { code, metaKey, ctrlKey, altKey, shiftKey } = event;
  if (altKey) return null;
  if (ctrlKey && !metaKey) return code === 'Tab' ? { kind: 'step-tab', delta: shiftKey ? -1 : 1 } : null;
  if (!metaKey || ctrlKey) return null;
  if (code === 'KeyZ') return { kind: shiftKey ? 'redo' : 'undo' };
  if (shiftKey) {
    if (code === 'KeyT') return { kind: 'reopen-tab' };
    if (code === 'BracketRight') return { kind: 'step-tab', delta: 1 };
    if (code === 'BracketLeft') return { kind: 'step-tab', delta: -1 };
    return null;
  }
  if (code === 'KeyW') return { kind: 'close-tab' };
  const digit = DIGIT_CODE.exec(code);
  if (digit === null) return null;
  const number = Number(digit[1]);
  return { kind: 'select-tab', index: number === LAST_DIGIT ? -1 : number - 1 };
}

function isTextField(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.includes(target.type);
  return target instanceof HTMLElement && target.isContentEditable;
}

@Injectable({ providedIn: 'root' })
export class Hotkeys {
  private readonly tabs = inject(TabsStore);
  private readonly worklog = inject(WorklogStore);

  handle(event: Event): void {
    if (!(event instanceof KeyboardEvent) || event.defaultPrevented) return;
    const hotkey = hotkeyOf(event);
    if (hotkey === null) return;
    // a text field keeps its own undo of typing
    if ((hotkey.kind === 'undo' || hotkey.kind === 'redo') && isTextField(event.target)) return;
    event.preventDefault();
    switch (hotkey.kind) {
      case 'close-tab':
        return this.tabs.closeFocused();
      case 'reopen-tab':
        return this.tabs.reopenClosed();
      case 'select-tab':
        return this.tabs.selectTab(hotkey.index);
      case 'step-tab':
        return this.tabs.stepTab(hotkey.delta);
      case 'undo':
        return inBackground(this.worklog.undo());
      case 'redo':
        return inBackground(this.worklog.redo());
    }
  }
}
