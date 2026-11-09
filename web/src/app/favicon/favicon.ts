import { ChangeDetectionStrategy, Component, computed, input, linkedSignal } from '@angular/core';

type IconState = 'loading' | 'loaded' | 'failed';

/** The site's favicon from Chrome's cache via the server; the projected content stands in until it loads or when there is none */
@Component({
  selector: 'wl-favicon',
  templateUrl: './favicon.html',
  styleUrl: './favicon.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-favicon', '[class.wl-favicon_failed]': "state() === 'failed'" },
})
export class Favicon {
  readonly url = input.required<string>();

  protected readonly src = computed(() => `/api/favicon?url=${encodeURIComponent(this.url())}`);
  protected readonly state = linkedSignal<string, IconState>({ source: this.url, computation: () => 'loading' });
}
