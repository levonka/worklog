import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import type { OnDestroy } from '@angular/core';

const LABEL_MS = 1500;
const LABELS = { idle: 'Скопировать', copied: 'Скопировано', failed: 'Не скопировалось' } as const;
type CopyState = keyof typeof LABELS;

/** A phrase to hand the agent, with a copy button */
@Component({
  selector: 'wl-prompt',
  templateUrl: './prompt.html',
  styleUrl: './prompt.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-prompt' },
})
export class Prompt implements OnDestroy {
  readonly text = input.required<string>();

  protected readonly state = signal<CopyState>('idle');
  protected readonly labels = LABELS;
  private timer: ReturnType<typeof setTimeout> | undefined;

  ngOnDestroy(): void {
    clearTimeout(this.timer);
  }

  protected copy(): void {
    const text = this.text();
    // the clipboard may be missing altogether, not only refuse
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(
        () => this.show('copied'),
        () => this.show('failed'),
      );
  }

  private show(state: CopyState): void {
    this.state.set(state);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.state.set('idle'), LABEL_MS);
  }
}
