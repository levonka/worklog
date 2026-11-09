import type { Status } from '@worklog/model';

/** CSS colour of a status dot */
export function statusDot(status: Status): string {
  return `var(--wl-st-${status}, var(--wl-text-3))`;
}
