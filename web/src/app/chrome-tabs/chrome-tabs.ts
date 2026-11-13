import { ChangeDetectionStrategy, Component, computed, ElementRef, inject, signal } from '@angular/core';
import { baseBranch, onboardingPrompts, TERMINAL_OPEN_LABELS } from '@worklog/model';
import { firstValueFrom } from 'rxjs';
import { ApiClient } from '../core/api';
import type { AgentLauncher } from '../core/api';
import { messageOf } from '../core/error-message';
import { ProfileStore } from '../core/profile-store';
import { WorklogStore } from '../core/worklog-store';
import { Prompt } from '../onboarding/prompt';

const GAP_PX = 8;

/** «Разобрать вкладки Chrome»: a bubble with what the agent will do, the phrase and the launch */
@Component({
  selector: 'wl-chrome-tabs',
  imports: [Prompt],
  templateUrl: './chrome-tabs.html',
  styleUrl: './chrome-tabs.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'wl-chrome-tabs',
    '(document:keydown.escape)': 'close()',
    '(document:pointerdown)': 'closeOutside($event)',
    '(window:resize)': 'place()',
  },
})
export class ChromeTabs {
  private readonly api = inject(ApiClient);
  private readonly worklog = inject(WorklogStore);
  private readonly profiles = inject(ProfileStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly open = signal(false);
  private readonly launcher = signal<AgentLauncher | null>(null);
  protected readonly sending = signal(false);
  protected readonly failure = signal<string | null>(null);
  /** fixed, so the sidebar's scroll does not cut the bubble off */
  protected readonly spot = signal({ left: 0, bottom: 0 });

  protected readonly phrase = computed(() => onboardingPrompts(this.profiles.profile(), this.worklog.state().directions).tabs);
  protected readonly canLaunch = computed(() => (this.launcher()?.agents.length ?? 0) > 0);
  protected readonly hint = computed(() => {
    const launcher = this.launcher();
    return launcher === null ? '' : `Откроется ${TERMINAL_OPEN_LABELS[launcher.terminal]}`;
  });

  protected toggle(): void {
    if (this.open()) {
      this.close();
      return;
    }
    this.failure.set(null);
    this.launcher.set(null);
    this.open.set(true);
    this.place();
    firstValueFrom(this.api.agentLauncher()).then(
      launcher => this.launcher.set(launcher),
      () => this.launcher.set(null),
    );
  }

  protected close(): void {
    this.open.set(false);
  }

  protected closeOutside(event: Event): void {
    if (this.open() && event.target instanceof Node && !this.host.nativeElement.contains(event.target)) this.close();
  }

  protected place(): void {
    if (!this.open()) return;
    const box = this.host.nativeElement.getBoundingClientRect();
    this.spot.set({ left: box.right + GAP_PX, bottom: window.innerHeight - box.bottom });
  }

  protected launch(): void {
    const launcher = this.launcher();
    if (launcher === null || this.sending()) return;
    this.sending.set(true);
    this.failure.set(null);
    this.worklog
      .startAgent({ template: 'tabs', include: [], extra: '', branch: baseBranch(this.profiles.profile()), agent: launcher.defaultAgent })
      .then(
        () => this.open.set(false),
        error => this.failure.set(messageOf(error, 'Не удалось запустить агента')),
      )
      .finally(() => this.sending.set(false));
  }
}
