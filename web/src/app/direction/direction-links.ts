import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import type { Direction } from '@worklog/model';
import { mergeRequestNumber, withScheme } from '@worklog/model';
import { LINK_ICONS } from '../core/link-icons';
import { WorklogStore } from '../core/worklog-store';
import { Favicon } from '../favicon/favicon';
import { LinkDescription } from '../link-description/link-description';
import { clearUntilFailed } from '../core/clear-until-failed';
import { inBackground } from '../core/background';

/** The direction's links with their kind icons and descriptions, and the «url [название]» form; MRs stand next to the tickets */
@Component({
  selector: 'wl-direction-links',
  imports: [Favicon, LinkDescription],
  templateUrl: './direction-links.html',
  styleUrl: './direction-links.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-direction-links' },
})
export class DirectionLinks {
  private readonly store = inject(WorklogStore);

  readonly direction = input.required<Direction>();

  protected readonly links = computed(() =>
    this.direction()
      .links.filter(link => mergeRequestNumber(link.url) === null)
      .map(link => ({ ...link, ...LINK_ICONS[link.kind] })),
  );
  /** the link whose description field is open */
  protected readonly editingUrl = signal<string | null>(null);

  protected add(urlField: HTMLInputElement, titleField: HTMLInputElement): void {
    const url = urlField.value.trim();
    if (url === '') return;
    const title = titleField.value.trim();
    const link = title === '' ? { url: withScheme(url) } : { url: withScheme(url), title };
    clearUntilFailed([urlField, titleField], this.store.addLink(this.direction().id, link));
  }

  protected saveDescription(url: string, text: string): void {
    this.editingUrl.set(null);
    inBackground(this.store.setLinkDescription(this.direction().id, url, text === '' ? null : text));
  }

  protected remove(url: string): void {
    inBackground(this.store.removeLink(this.direction().id, url));
  }
}
