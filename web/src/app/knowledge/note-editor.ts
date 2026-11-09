import { afterNextRender, ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal, output, signal, viewChild } from '@angular/core';
import type { ElementRef } from '@angular/core';
import type { Note, NoteFile, NoteUrl } from '@worklog/model';
import { noteLinkLines, parseNoteLink } from '@worklog/model';
import { messageOf } from '../core/error-message';
import { WorklogStore } from '../core/worklog-store';

/** Creates a note, or edits `note`; ⌘↩ saves, Esc closes without saving */
@Component({
  selector: 'wl-note-editor',
  templateUrl: './note-editor.html',
  styleUrl: './note-editor.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-note-editor', '(keydown.meta.enter)': 'save()', '(keydown.escape)': 'close($event)' },
})
export class NoteEditor {
  private readonly store = inject(WorklogStore);

  readonly note = input<Note | null>(null);
  /** a new note starts attached to this direction */
  readonly directionId = input<string | null>(null);
  readonly done = output<void>();

  private readonly titleField = viewChild.required<ElementRef<HTMLInputElement>>('titleField');
  private readonly bodyField = viewChild.required<ElementRef<HTMLTextAreaElement>>('bodyField');
  private readonly linksField = viewChild.required<ElementRef<HTMLTextAreaElement>>('linksField');

  protected readonly directionIds = linkedSignal(() => {
    const preset = this.directionId();
    return this.note()?.directionIds ?? (preset === null ? [] : [preset]);
  });
  protected readonly attached = computed(() => this.store.state().directions.filter(d => this.directionIds().includes(d.id)));
  protected readonly available = computed(() =>
    this.store
      .state()
      .directions.filter(d => d.status !== 'done' && !this.directionIds().includes(d.id))
      .sort((a, b) => a.title.localeCompare(b.title, 'ru')),
  );
  protected readonly linkText = computed(() => {
    const note = this.note();
    return note === null ? '' : noteLinkLines(note).join('\n');
  });
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);

  constructor() {
    afterNextRender(() => this.titleField().nativeElement.focus());
  }

  protected attach(select: HTMLSelectElement): void {
    const id = select.value;
    select.value = '';
    if (id !== '') this.directionIds.update(ids => [...ids, id]);
  }

  protected detach(id: string): void {
    this.directionIds.update(ids => ids.filter(other => other !== id));
  }

  protected close(event: Event): void {
    event.stopPropagation();
    this.done.emit();
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    const title = this.titleField().nativeElement.value.trim();
    if (title === '') {
      this.error.set('Нужен заголовок');
      return;
    }
    const files: NoteFile[] = [];
    const urls: NoteUrl[] = [];
    const unknown: string[] = [];
    for (const line of this.linksField().nativeElement.value.split('\n')) {
      if (line.trim() === '') continue;
      const link = parseNoteLink(line);
      if (link === null) unknown.push(line.trim());
      else if ('file' in link) files.push(link.file);
      else urls.push(link.url);
    }
    if (unknown.length > 0) {
      this.error.set(`Не понял ссылку: ${unknown.join(', ')}. Нужен путь от корня проекта (src/x.ts:42) или https://…`);
      return;
    }
    const body = { title, body: this.bodyField().nativeElement.value, directionIds: this.directionIds(), files, urls };
    const note = this.note();
    this.saving.set(true);
    try {
      if (note === null) await this.store.createNote(body);
      else await this.store.updateNote(note.id, body);
      this.done.emit();
    } catch (error) {
      this.error.set(messageOf(error, 'Не удалось сохранить заметку'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async remove(): Promise<void> {
    const note = this.note();
    if (note === null) return;
    try {
      await this.store.deleteNote(note.id);
      this.done.emit();
    } catch (error) {
      this.error.set(messageOf(error, 'Не удалось удалить заметку'));
    }
  }
}
