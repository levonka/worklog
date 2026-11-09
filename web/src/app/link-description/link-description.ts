import { afterRenderEffect, ChangeDetectionStrategy, Component, input, output, viewChild } from '@angular/core';
import type { ElementRef } from '@angular/core';
import { RichText } from '../rich-text/rich-text';

/** A link's description: the text, or its field while the parent says it is being edited */
@Component({
  selector: 'wl-link-description',
  imports: [RichText],
  templateUrl: './link-description.html',
  styleUrl: './link-description.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-link-description' },
})
export class LinkDescription {
  readonly text = input<string | undefined>();
  readonly editing = input(false);
  readonly edit = output<void>();
  /** the trimmed text, empty to remove the description; only when it changed */
  readonly save = output<string>();
  readonly cancel = output<void>();

  private readonly field = viewChild<ElementRef<HTMLTextAreaElement>>('field');
  // Escape closes the field, and the blur that may follow must not save it
  private cancelled = false;

  constructor() {
    afterRenderEffect(() => {
      const field = this.field()?.nativeElement;
      if (!field) return;
      this.cancelled = false;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    });
  }

  protected commit(raw: string): void {
    if (this.cancelled) return;
    const text = raw.trim();
    if (text === (this.text() ?? '')) this.cancel.emit();
    else this.save.emit(text);
  }

  protected abandon(event: Event): void {
    event.stopPropagation();
    this.cancelled = true;
    this.cancel.emit();
  }
}
