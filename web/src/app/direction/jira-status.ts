import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { jiraTone } from '@worklog/model';
import { ProfileStore } from '../core/profile-store';

/** A ticket's Jira status, coloured by where it is in the workflow */
@Component({
  selector: 'wl-jira-status',
  template: '{{ status() }}',
  styleUrl: './jira-status.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class]': "'wl-jira-status wl-jira-status_' + tone()" },
})
export class JiraStatus {
  private readonly profiles = inject(ProfileStore);

  readonly status = input.required<string>();

  protected readonly tone = computed(() => jiraTone(this.status(), this.profiles.profile()));
}
