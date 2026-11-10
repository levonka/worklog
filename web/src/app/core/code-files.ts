import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiClient } from './api';
import { WorklogStore } from './worklog-store';

/** which note file links point to files that are gone and whether they open at all; checked again whenever note links change */
@Injectable({ providedIn: 'root' })
export class CodeFiles {
  private readonly api = inject(ApiClient);
  private readonly worklog = inject(WorklogStore);

  private readonly missingPaths = signal<ReadonlySet<string>>(new Set());
  readonly missing = this.missingPaths.asReadonly();
  private readonly canOpen = signal(true);
  /** false without an editor or a project folder */
  readonly openable = this.canOpen.asReadonly();
  // bumped by every check: an older answer must not overwrite a newer one
  private generation = 0;

  private readonly fileKey = computed(() => JSON.stringify(this.worklog.state().notes.map(note => note.files)));

  constructor() {
    effect(() => {
      this.fileKey();
      untracked(() => void this.check());
    });
  }

  // never rejects: without an answer the last known marks stay
  async check(): Promise<void> {
    const generation = ++this.generation;
    try {
      const { missing, openable } = await firstValueFrom(this.api.missingFiles());
      if (generation !== this.generation) return;
      this.missingPaths.set(new Set(missing));
      this.canOpen.set(openable);
    } catch {
      // the server is restarting or unreachable
    }
  }
}
