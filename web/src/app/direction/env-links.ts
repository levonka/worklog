import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import type { OnDestroy } from '@angular/core';
import type { Ticket } from '@worklog/model';
import { ENV_ROW_LABELS, ENV_ROWS, envCopyText, envPlatforms, envSegments, envUrl, profileSegments, storybookLinks } from '@worklog/model';
import { inBackground } from '../core/background';
import { plural } from '../core/plural';
import { ProfileStore } from '../core/profile-store';

const COPIED_MS = 2000;
const LINK_FORMS = { one: 'ссылка', few: 'ссылки', many: 'ссылок' };

interface Cell {
  segment: string;
  url: string | null;
  off: boolean;
}

/** Stands and builds of the branch: only the segments of the tickets' Segment field, the rest on request */
@Component({
  selector: 'wl-env-links',
  templateUrl: './env-links.html',
  styleUrl: './env-links.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-env-links' },
})
export class EnvLinks implements OnDestroy {
  private readonly profiles = inject(ProfileStore);

  readonly tickets = input.required<readonly Ticket[]>();
  readonly branch = input.required<string>();

  protected readonly expanded = signal(false);
  protected readonly copied = signal<string | null>(null);
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly profile = this.profiles.profile;
  private readonly allSegments = computed(() => profileSegments(this.profile()));
  private readonly segmentsOf = computed(() =>
    envPlatforms(this.tickets(), this.profile()).map(platform => ({ platform, segments: envSegments(this.tickets(), platform, this.profile()) })),
  );
  private readonly folded = computed(() => this.allSegments().filter(segment => this.segmentsOf().some(group => group.segments.includes(segment))));

  protected readonly hidden = computed(() => this.allSegments().filter(segment => !this.folded().includes(segment)));
  protected readonly columns = computed<readonly string[]>(() => (this.expanded() ? this.allSegments() : this.folded()));
  protected readonly groups = computed(() =>
    this.segmentsOf().map(({ platform, segments }) => ({
      platform,
      rows: ENV_ROWS.filter(row => this.allSegments().some(segment => envUrl(platform, row, segment, this.branch(), this.profile()) !== null)).map(row => ({
        label: ENV_ROW_LABELS[row],
        cells: this.columns().map<Cell>(segment => {
          const own = segments.includes(segment);
          return { segment, url: own || this.expanded() ? envUrl(platform, row, segment, this.branch(), this.profile()) : null, off: !own };
        }),
      })),
    })),
  );
  protected readonly storybook = computed(() => storybookLinks(this.branch(), this.profile()));

  ngOnDestroy(): void {
    clearTimeout(this.copiedTimer);
  }

  protected copy(platform: string): void {
    const own = this.segmentsOf().find(group => group.platform === platform)?.segments ?? [];
    const segments = this.expanded() ? this.allSegments() : own;
    const count = ENV_ROWS.flatMap(row => segments.flatMap(segment => envUrl(platform, row, segment, this.branch(), this.profile()) ?? [])).length;
    inBackground(
      navigator.clipboard.writeText(envCopyText(platform, segments, this.branch(), this.profile())).then(() => {
        this.copied.set(`Скопировано: ${platform}, ${count} ${plural(count, LINK_FORMS)}`);
        clearTimeout(this.copiedTimer);
        this.copiedTimer = setTimeout(() => this.copied.set(null), COPIED_MS);
      }),
    );
  }
}
