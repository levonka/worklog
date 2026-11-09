import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export interface TextPart {
  kind: 'text' | 'code' | 'url';
  value: string;
}

// `code` in backquotes, or an address; trailing punctuation stays outside the address
const TOKEN = /`([^`\n]+)`|https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]»]/g;

export function textParts(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (match.index > last) parts.push({ kind: 'text', value: text.slice(last, match.index) });
    parts.push(match[1] === undefined ? { kind: 'url', value: match[0] } : { kind: 'code', value: match[1] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) });
  return parts;
}

/** Plain text with its line breaks; `code` and addresses stand out, addresses open in Chrome */
@Component({
  selector: 'wl-rich-text',
  // one line: whitespace between the parts would show, the host keeps line breaks
  template: `@for (part of parts(); track $index) {@switch (part.kind) {@case ('code') {<code class="rt__code">{{ part.value }}</code>}@case ('url') {<a class="rt__link" [href]="part.value" target="_blank" rel="noopener">{{ part.value }}</a>}@default {<span>{{ part.value }}</span>}}}`,
  styleUrl: './rich-text.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-rich-text' },
})
export class RichText {
  readonly text = input.required<string>();

  protected readonly parts = computed(() => textParts(this.text()));
}
