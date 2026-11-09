import { TestBed } from '@angular/core/testing';
import { DragCancel } from './drag-cancel';

function press(key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  return event;
}

describe('DragCancel', () => {
  let cancel: DragCancel;
  const ups = vi.fn();

  beforeEach(() => {
    cancel = TestBed.inject(DragCancel);
    ups.mockClear();
    document.addEventListener('mouseup', ups);
  });

  afterEach(() => {
    document.removeEventListener('mouseup', ups);
    cancel.consume();
    TestBed.resetTestingModule();
  });

  it('Esc during a drag ends it with a mouseup and marks the drop that follows as cancelled', () => {
    cancel.arm();
    const esc = press('Escape');

    expect(ups).toHaveBeenCalledTimes(1);
    expect(esc.defaultPrevented).toBe(true);
    expect(document.body.classList.contains('wl-drag-cancelled')).toBe(true);
    expect(cancel.consume()).toBe(true);
    expect(document.body.classList.contains('wl-drag-cancelled')).toBe(false);
    expect(cancel.consume()).toBe(false);
  });

  it('Esc does not reach the handlers of the page while a drag is on', () => {
    const below = vi.fn();
    document.body.addEventListener('keydown', below);
    try {
      cancel.arm();
      press('Escape');
      expect(below).not.toHaveBeenCalled();
    } finally {
      document.body.removeEventListener('keydown', below);
    }
  });

  it('a drop without Esc is not cancelled, and after it Esc is left alone', () => {
    cancel.arm();
    press('Enter');
    expect(cancel.consume()).toBe(false);

    const esc = press('Escape');
    expect(ups).not.toHaveBeenCalled();
    expect(esc.defaultPrevented).toBe(false);
  });
});
