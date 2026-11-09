import { CdkDrag, CdkDropList } from '@angular/cdk/drag-drop';
import type { CdkDragDrop, CdkDragMove } from '@angular/cdk/drag-drop';
import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import type { Todo } from '@worklog/model';
import { DragCancel } from '../core/drag-cancel';
import { attributeAt, DropHint } from '../core/drop-hint';
import { WorklogStore } from '../core/worklog-store';
import { TodoRow } from './todo-row';
import { inBackground } from '../core/background';
import { clearUntilFailed } from '../core/clear-until-failed';

@Component({
  selector: 'wl-todo-list',
  imports: [CdkDropList, CdkDrag, TodoRow],
  templateUrl: './todo-list.html',
  styleUrl: './todo-list.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-todo-list' },
})
export class TodoList {
  private readonly store = inject(WorklogStore);
  private readonly document = inject(DOCUMENT);
  protected readonly dropHint = inject(DropHint);
  protected readonly dragCancel = inject(DragCancel);

  /** shows only this direction's todos and links new ones to it */
  readonly directionId = input<string>();

  protected readonly todos = computed(() => this.ofDirection(this.store.openTodos()));
  protected readonly doneToday = computed(() => this.ofDirection(this.store.doneToday()));
  protected readonly doneExpanded = signal(false);

  protected add(field: HTMLInputElement): void {
    const text = field.value.trim();
    if (text === '') return;
    const directionId = this.directionId();
    clearUntilFailed([field], this.store.addTodo(directionId === undefined ? { text } : { text, directionId }));
  }

  protected todoMoved(todo: Todo, event: Pick<CdkDragMove, 'pointerPosition'>): void {
    const directionId = attributeAt(this.document, event.pointerPosition.x, event.pointerPosition.y, 'data-direction-id');
    this.dropHint.show(directionId === null || directionId === todo.directionId ? null : { kind: 'direction', directionId });
  }

  protected dropped(event: CdkDragDrop<unknown, unknown, string>): void {
    if (this.dragCancel.consume()) return;
    const id = event.item.data;
    if (!event.isPointerOverContainer) {
      this.linkToCardAt(id, event.dropPoint.x, event.dropPoint.y);
      return;
    }
    // the list may show only some todos while the server orders all of them: take the place of the todo dropped onto
    const target = this.todos().at(event.currentIndex);
    if (event.previousIndex === event.currentIndex || target === undefined) return;
    inBackground(this.store.moveTodo(id, this.store.state().todos.indexOf(target)));
  }

  private linkToCardAt(id: string, x: number, y: number): void {
    const directionId = attributeAt(this.document, x, y, 'data-direction-id');
    if (directionId === null || this.store.state().todos.find(todo => todo.id === id)?.directionId === directionId) return;
    inBackground(this.store.updateTodo(id, { directionId }));
  }

  private ofDirection(todos: Todo[]): Todo[] {
    const directionId = this.directionId();
    return directionId === undefined ? todos : todos.filter(todo => todo.directionId === directionId);
  }
}
