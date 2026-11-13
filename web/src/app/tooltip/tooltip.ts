import { DOCUMENT } from '@angular/common';
import { DestroyRef, Directive, ElementRef, inject, input } from '@angular/core';

const GAP = 6;
const EDGE = 4;

interface Size {
  width: number;
  height: number;
}

interface Rect extends Size {
  left: number;
  top: number;
}

/** Above the element and centred on it, below when there is no room above, never past the window's edges */
export function tooltipPlace(anchor: Rect, tip: Size, view: Size): { left: number; top: number } {
  const centred = anchor.left + anchor.width / 2 - tip.width / 2;
  const left = Math.max(EDGE, Math.min(centred, view.width - tip.width - EDGE));
  const above = anchor.top - GAP - tip.height;
  return { left, top: above >= EDGE ? above : anchor.top + anchor.height + GAP };
}

/** The text in a label over the page while the pointer is on the element: shows at once, unlike a native title */
@Directive({
  selector: '[wlTooltip]',
  host: {
    '(mouseenter)': 'show()',
    '(mouseleave)': 'hide()',
    '(pointerdown)': 'hide()',
    '(wheel)': 'hide()',
  },
})
export class Tooltip {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly document = inject(DOCUMENT);

  readonly wlTooltip = input.required<string>();

  private tip: HTMLElement | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.hide());
  }

  protected show(): void {
    this.hide();
    const text = this.wlTooltip();
    if (text === '') return;

    const tip = this.document.createElement('div');
    tip.className = 'wl-tooltip';
    tip.setAttribute('role', 'tooltip');
    tip.textContent = text;
    this.document.body.append(tip);

    const { clientWidth, clientHeight } = this.document.documentElement;
    const place = tooltipPlace(this.host.nativeElement.getBoundingClientRect(), tip.getBoundingClientRect(), { width: clientWidth, height: clientHeight });
    tip.style.left = `${place.left}px`;
    tip.style.top = `${place.top}px`;
    this.tip = tip;
  }

  protected hide(): void {
    this.tip?.remove();
    this.tip = null;
  }
}
