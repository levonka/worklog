import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';

// while on the body, the drag preview skips its flight to the slot it hovered and the item is back in place at once
const CANCELLED_CLASS = 'wl-drag-cancelled';

/** Esc during a drag puts the item back: CDK has no cancel, so the drag is ended and its drop ignored */
@Injectable({ providedIn: 'root' })
export class DragCancel {
  private readonly document = inject(DOCUMENT);
  private cancelled = false;
  private stopListening: (() => void) | null = null;

  /** a drag started: from now until its drop Esc cancels it */
  arm(): void {
    this.disarm();
    this.cancelled = false;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.cancel();
    };
    this.document.addEventListener('keydown', onKey, true);
    this.stopListening = () => this.document.removeEventListener('keydown', onKey, true);
  }

  /** whether the drop being handled was cancelled with Esc; the drag is over either way */
  consume(): boolean {
    const cancelled = this.cancelled;
    this.cancelled = false;
    this.disarm();
    this.document.body.classList.remove(CANCELLED_CLASS);
    return cancelled;
  }

  private cancel(): void {
    this.cancelled = true;
    this.disarm();
    this.document.body.classList.add(CANCELLED_CLASS);
    // CDK ends a mouse drag on the next mouseup on the document
    this.document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }

  private disarm(): void {
    this.stopListening?.();
    this.stopListening = null;
  }
}
