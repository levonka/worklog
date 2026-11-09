import { DOCUMENT } from '@angular/common';
import { DestroyRef, inject, Injectable, signal } from '@angular/core';

const DAY_MS = 86_400_000;

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** calendar days from `from` to `to`, negative when `to` is earlier */
export function daysBetween(from: Date, to: Date): number {
  // rounding absorbs the 23- and 25-hour days of a DST switch
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / DAY_MS);
}

/** The current local day; computeds that compare with «today» read it so they change at midnight */
@Injectable({ providedIn: 'root' })
export class Clock {
  private readonly document = inject(DOCUMENT);
  private readonly day = signal(startOfDay(new Date()), { equal: (a, b) => a.getTime() === b.getTime() });
  private timer: ReturnType<typeof setTimeout> | undefined;

  readonly today = this.day.asReadonly();

  constructor() {
    // a sleeping Mac skips timers: waking up shows the window, which catches up here
    const update = (): void => this.update();
    this.document.defaultView?.addEventListener('focus', update);
    this.document.addEventListener('visibilitychange', update);
    this.scheduleMidnight();
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.timer);
      this.document.defaultView?.removeEventListener('focus', update);
      this.document.removeEventListener('visibilitychange', update);
    });
  }

  private update(): void {
    this.day.set(startOfDay(new Date()));
    this.scheduleMidnight();
  }

  private scheduleMidnight(): void {
    clearTimeout(this.timer);
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    this.timer = setTimeout(() => this.update(), midnight.getTime() - now.getTime());
  }
}
