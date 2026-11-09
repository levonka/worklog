import { HttpErrorResponse } from '@angular/common/http';

export const NO_CONNECTION = 'Нет связи с сервером Worklog';

/** the server's `{ error }` text, or the fallback when the request got no such answer */
export function messageOf(error: unknown, fallback: string): string {
  const body: unknown = error instanceof HttpErrorResponse ? error.error : null;
  if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') return body.error;
  return fallback;
}
