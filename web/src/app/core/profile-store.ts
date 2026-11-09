import { inject, Injectable, signal } from '@angular/core';
import type { Profile } from '@worklog/model';
import { firstValueFrom } from 'rxjs';
import { ApiClient } from './api';

/** The company profile the server started with; null without one */
@Injectable({ providedIn: 'root' })
export class ProfileStore {
  private readonly api = inject(ApiClient);
  private readonly current = signal<Profile | null>(null);

  readonly profile = this.current.asReadonly();

  // never rejects: without an answer the app works as without a profile
  async load(): Promise<void> {
    try {
      this.current.set((await firstValueFrom(this.api.getProfile())).profile);
    } catch {
      // the connection banner already tells about a server that is down
    }
  }
}
