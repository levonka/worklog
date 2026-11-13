import { DOCUMENT } from '@angular/common';
import { afterNextRender, ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, Injector, PendingTasks, signal, untracked, viewChild } from '@angular/core';
import type { ElementRef } from '@angular/core';
import { onboardingPrompts } from '@worklog/model';
import { hotkeyOf } from '../core/hotkeys';
import { ProfileStore } from '../core/profile-store';
import { WorklogStore } from '../core/worklog-store';
import { Prompt } from './prompt';
import { Tour } from './tour';
import type { TourView } from './tour';
import { TourDemo } from './tour-demo';
import type { BubblePlace, Rect, Size } from './tour-place';
import { tourBubblePlace } from './tour-place';
import type { TourStep } from './tour-steps';
import { targetSelector } from './tour-steps';

const RING_PADDING = 6;
// room for the ring's own 2 px line and its halo
const RING_EDGE = 4;

/** The tour's bubble over a dimmed window with a ring around the step's target; clicks do not reach the app underneath */
@Component({
  selector: 'wl-tour',
  imports: [Prompt, TourDemo],
  templateUrl: './tour-overlay.html',
  styleUrl: './tour-overlay.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-tour', '(window:resize)': 'measure()' },
})
export class TourOverlay {
  protected readonly tour = inject(Tour);
  private readonly worklog = inject(WorklogStore);
  private readonly profiles = inject(ProfileStore);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly pendingTasks = inject(PendingTasks);
  private readonly bubble = viewChild<ElementRef<HTMLElement>>('bubble');
  private readonly primary = viewChild<ElementRef<HTMLButtonElement>>('primary');

  protected readonly view = this.tour.current;
  protected readonly ring = signal<Rect | null>(null);
  protected readonly place = signal<BubblePlace | null>(null);
  protected readonly prompts = computed(() => {
    const keys = this.view()?.step.prompts ?? [];
    if (keys.length === 0) return [];
    const prompts = onboardingPrompts(this.profiles.profile(), this.worklog.state().directions);
    return keys.map(key => prompts[key]);
  });

  constructor() {
    // each step is measured once it is drawn: its screen opens in the same render
    effect(() => {
      if (this.view() === null) return;
      // the ring stays to glide to the next target; the bubble waits for its new place
      untracked(() => this.place.set(null));
      afterNextRender(() => this.measure(), { injector: this.injector });
    });

    // in the capture phase: the window's own shortcuts must not act under the tour
    const onKey = (event: KeyboardEvent): void => this.key(event);
    this.document.addEventListener('keydown', onKey, true);
    inject(DestroyRef).onDestroy(() => this.document.removeEventListener('keydown', onKey, true));
  }

  protected measure(): void {
    const view = this.view();
    if (view === null) return;
    try {
      const target = view.step.target === null ? null : this.findTarget(view.step);
      // the step's target is not on screen: no bubble pointing at nothing
      if (view.step.target !== null && target === null) {
        this.skipLater(view);
        return;
      }
      if (target !== null && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center', inline: 'nearest' });
      const bounds = { width: this.document.documentElement.clientWidth, height: this.document.documentElement.clientHeight };
      const ring = target === null ? null : ringAround(target.getBoundingClientRect(), bounds);
      const bubble = this.bubble()?.nativeElement;
      const size = { width: bubble?.offsetWidth ?? 0, height: bubble?.offsetHeight ?? 0 };
      this.ring.set(ring);
      this.place.set(tourBubblePlace(ring, size, bounds));
      this.primary()?.nativeElement.focus({ preventScroll: true });
    } catch {
      // the tour never stands in the way of work
      this.tour.close();
    }
  }

  // outside this render: several steps skipped in a row would otherwise loop change detection
  private skipLater(view: TourView): void {
    this.pendingTasks.run(
      () =>
        new Promise<void>(resolve =>
          setTimeout(() => {
            if (this.tour.current() === view) this.tour.skip();
            resolve();
          }),
        ),
    );
  }

  private findTarget(step: TourStep): HTMLElement | null {
    const selector = step.target === null ? null : targetSelector(step.target, this.tour.directionId());
    if (selector === null) return null;
    const directionId = this.tour.directionId();
    // a direction's own controls are looked for in its view: another direction may stand in the other pane
    const root = step.screen === 'direction' && directionId !== null ? this.directionView(directionId) : this.document;
    if (root === null) return null;
    const found = Array.from(root.querySelectorAll<HTMLElement>(selector));
    return found.find(element => element.getBoundingClientRect().width > 0) ?? found[0] ?? null;
  }

  private directionView(directionId: string): HTMLElement | null {
    return Array.from(this.document.querySelectorAll<HTMLElement>('[data-direction-view]')).find(element => element.dataset['directionView'] === directionId) ?? null;
  }

  private key(event: KeyboardEvent): void {
    if (this.view() === null) return;
    const onButton = event.target instanceof HTMLButtonElement && event.target.closest('.wl-tour') !== null;
    if (event.key === 'Escape') this.tour.close();
    else if (event.key === 'ArrowRight' || (event.key === 'Enter' && !onButton)) this.tour.next();
    else if (event.key === 'ArrowLeft') this.tour.back();
    // a focused button of the bubble takes Enter itself; other shortcuts of the window wait for the tour's end
    else if (hotkeyOf(event) === null) return;
    event.preventDefault();
    event.stopPropagation();
  }
}

// a target at the window's edge keeps its whole ring on screen
function ringAround(rect: DOMRect, bounds: Size): Rect {
  const left = Math.max(RING_EDGE, rect.left - RING_PADDING);
  const top = Math.max(RING_EDGE, rect.top - RING_PADDING);
  const right = Math.min(bounds.width - RING_EDGE, rect.right + RING_PADDING);
  const bottom = Math.min(bounds.height - RING_EDGE, rect.bottom + RING_PADDING);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}
