import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { WorklogStore } from '../core/worklog-store';
import { NoteCard } from './note-card';
import { NoteEditor } from './note-editor';

/** The notes of one direction and a new one already attached to it */
@Component({
  selector: 'wl-direction-notes',
  imports: [NoteCard, NoteEditor],
  templateUrl: './direction-notes.html',
  styleUrl: './direction-notes.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-direction-notes' },
})
export class DirectionNotes {
  private readonly store = inject(WorklogStore);

  readonly directionId = input.required<string>();

  protected readonly creating = signal(false);
  protected readonly notes = computed(() => this.store.notesOf(this.directionId()));
}
