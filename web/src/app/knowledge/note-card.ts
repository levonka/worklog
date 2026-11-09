import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import type { Note, NoteFile } from '@worklog/model';
import { fileLabel } from '@worklog/model';
import { inBackground } from '../core/background';
import { CodeFiles } from '../core/code-files';
import { TabsStore } from '../core/tabs-store';
import { WorklogStore } from '../core/worklog-store';
import { RichText } from '../rich-text/rich-text';
import { NoteEditor } from './note-editor';

// a bare README.md or index.ts says nothing without its folder
const GENERIC_NAMES = new Set(['README.md', 'index.ts', 'index.html', 'package.json', 'project.json']);

export function shortFileLabel(file: NoteFile): string {
  const parts = file.path.split('/');
  const name = parts.at(-1) ?? file.path;
  const short = GENERIC_NAMES.has(name) && parts.length > 1 ? parts.slice(-2).join('/') : name;
  return file.line === undefined ? short : `${short}:${file.line}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** A note: text, links (files open in the code editor), its directions; ✎ turns it into the note editor */
@Component({
  selector: 'wl-note-card',
  imports: [NoteEditor, RichText],
  templateUrl: './note-card.html',
  styleUrl: './note-card.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-note-card' },
})
export class NoteCard {
  private readonly store = inject(WorklogStore);
  private readonly tabs = inject(TabsStore);
  private readonly codeFiles = inject(CodeFiles);

  readonly note = input.required<Note>();
  /** off inside a direction: the note is already shown under it */
  readonly showDirections = input(true);

  protected readonly editing = signal(false);
  protected readonly directions = computed(() => this.store.state().directions.filter(d => this.note().directionIds.includes(d.id)));
  protected readonly files = computed(() =>
    this.note().files.map(file => ({ file, label: fileLabel(file), short: shortFileLabel(file), missing: this.codeFiles.missing().has(file.path) })),
  );
  protected readonly urls = computed(() => this.note().urls.map(url => ({ ...url, label: url.title ?? hostOf(url.url) })));

  protected open(file: NoteFile): void {
    inBackground(this.store.openFile(file));
  }

  protected openDirection(id: string): void {
    this.tabs.openTab(`direction:${id}`);
  }
}
