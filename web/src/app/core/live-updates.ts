import { inject, Injectable, signal } from '@angular/core';
import { JiraHealthStore } from './jira-health';
import { ProfileStore } from './profile-store';
import { WorklogStore } from './worklog-store';
import { inBackground } from './background';

const RECONNECT_MS = 3_000;

@Injectable({ providedIn: 'root' })
export class LiveUpdates {
  private readonly store = inject(WorklogStore);
  private readonly jira = inject(JiraHealthStore);
  private readonly profiles = inject(ProfileStore);
  private readonly isConnected = signal(true);
  private started = false;

  readonly connected = this.isConnected.asReadonly();

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  private connect(): void {
    const source = new EventSource('/api/live');
    // also on every reconnect: changes made while the stream was down sent no event
    source.addEventListener('open', () => {
      this.isConnected.set(true);
      this.reload();
      // a restarted server may have a different profile
      inBackground(this.profiles.load());
    });
    source.addEventListener('error', () => {
      this.isConnected.set(false);
      // the browser retries on its own unless it gave up, e.g. after a non-200 answer
      if (source.readyState !== EventSource.CLOSED) return;
      source.close();
      setTimeout(() => this.connect(), RECONNECT_MS);
    });
    source.addEventListener('change', () => this.reload());
  }

  private reload(): void {
    inBackground(this.store.refresh());
    inBackground(this.jira.load());
  }
}
