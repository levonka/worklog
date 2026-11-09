import { inject, Injectable, signal } from '@angular/core';
import type { JiraHealth } from '@worklog/model';
import { firstValueFrom } from 'rxjs';
import { ApiClient } from './api';

/** What the server knows about Jira; the statuses themselves come with the state */
@Injectable({ providedIn: 'root' })
export class JiraHealthStore {
  private readonly api = inject(ApiClient);
  private readonly current = signal<JiraHealth | null>(null);
  private readonly busy = signal(false);

  readonly health = this.current.asReadonly();
  readonly refreshing = this.busy.asReadonly();

  // never rejects: without an answer the last one stays
  async load(): Promise<void> {
    try {
      this.current.set(await firstValueFrom(this.api.getJira()));
    } catch {
      // the connection banner already tells about a server that is down
    }
  }

  async refresh(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      this.current.set(await firstValueFrom(this.api.refreshJira()));
    } catch {
      // as in load
    } finally {
      this.busy.set(false);
    }
  }
}
