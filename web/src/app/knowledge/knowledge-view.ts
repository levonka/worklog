import { ChangeDetectionStrategy, Component, computed, inject, signal, viewChild } from '@angular/core';
import type { ElementRef } from '@angular/core';
import { noteMatches } from '@worklog/model';
import { CodeFiles } from '../core/code-files';
import { WorklogStore } from '../core/worklog-store';
import { NoteCard } from './note-card';
import { NoteEditor } from './note-editor';

/** Projected content goes to the end of the header: the pane puts its own controls there */
@Component({
  selector: 'wl-knowledge-view',
  imports: [NoteCard, NoteEditor],
  templateUrl: './knowledge-view.html',
  styleUrl: './knowledge-view.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-knowledge-view', '(document:keydown.meta.f)': 'focusSearch($event)' },
})
export class KnowledgeView {
  private readonly worklog = inject(WorklogStore);
  private readonly codeFiles = inject(CodeFiles);

  private readonly searchInput = viewChild.required<ElementRef<HTMLInputElement>>('searchBox');
  protected readonly query = signal('');
  protected readonly creating = signal(false);
  protected readonly shown = computed(() => this.worklog.notes().filter(note => noteMatches(note, this.query(), this.worklog.state().directions)));

  constructor() {
    // files may have gone since the last check: the code changes outside Worklog
    void this.codeFiles.check();
  }

  protected focusSearch(event: Event): void {
    event.preventDefault();
    this.searchInput().nativeElement.focus();
  }
}
