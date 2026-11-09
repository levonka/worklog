import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import type { OnDestroy } from '@angular/core';
import { inBackground } from '../core/background';

const COPIED_MS = 2000;

/** «Ветка feature/APP-1_WEB-2 ⧉» */
@Component({
  selector: 'wl-branch-line',
  templateUrl: './branch-line.html',
  styleUrl: './branch-line.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-branch-line' },
})
export class BranchLine implements OnDestroy {
  readonly branch = input.required<string>();

  protected readonly copied = signal(false);
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;

  ngOnDestroy(): void {
    clearTimeout(this.copiedTimer);
  }

  protected copy(): void {
    inBackground(
      navigator.clipboard.writeText(this.branch()).then(() => {
        this.copied.set(true);
        clearTimeout(this.copiedTimer);
        this.copiedTimer = setTimeout(() => this.copied.set(false), COPIED_MS);
      }),
    );
  }
}
