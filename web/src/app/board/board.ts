import { CdkDrag, CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
import type { CdkDragDrop, CdkDragMove } from '@angular/cdk/drag-drop';
import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { Direction, Status, Todo } from '@worklog/model';
import { BOARD_STATUSES, dropIntent, STATUS_LABELS } from '@worklog/model';
import { DragCancel } from '../core/drag-cancel';
import { attributeAt, DropHint } from '../core/drop-hint';
import { plural } from '../core/plural';
import { statusDot } from '../core/status-dot';
import { TabsStore } from '../core/tabs-store';
import { WorklogStore } from '../core/worklog-store';
import { DirectionCard } from './direction-card';
import { NewDirectionForm } from './new-direction-form';
import { inBackground } from '../core/background';

interface Column {
  /** all drop lists of the board carry a Status, so one handler takes every drop */
  status: Status;
  label: string;
  dot: string;
  directions: Direction[];
}

/** Projected content goes to the end of the toolbar: the pane puts its own controls there */
@Component({
  selector: 'wl-board',
  imports: [CdkDropListGroup, CdkDropList, CdkDrag, DirectionCard, NewDirectionForm],
  templateUrl: './board.html',
  styleUrl: './board.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-board' },
})
export class Board {
  protected readonly store = inject(WorklogStore);
  private readonly tabs = inject(TabsStore);
  protected readonly dropHint = inject(DropHint);
  protected readonly dragCancel = inject(DragCancel);
  private readonly document = inject(DOCUMENT);

  protected readonly stats = this.store.todoStats;
  protected readonly parked = this.store.parked;
  protected readonly done = this.store.doneDirections;

  protected readonly parkedStatus: Status = 'parked';
  protected readonly columns = computed<Column[]>(() => {
    const columns = this.store.columns();
    return BOARD_STATUSES.map(status => ({ status, label: STATUS_LABELS[status], dot: statusDot(status), directions: columns[status] }));
  });
  protected readonly activeLabel = computed(() => {
    const count = this.columns().reduce((sum, column) => sum + column.directions.length, 0);
    return `${count} ${plural(count, { one: 'активное', few: 'активных', many: 'активных' })}`;
  });
  /** a new user: no directions anywhere yet */
  protected readonly empty = computed(() => this.columns().every(column => column.directions.length === 0) && this.parked().length === 0 && this.done().length === 0);
  protected readonly parkedTitles = computed(() => this.parked().map(direction => direction.title).join(', '));

  protected readonly adding = signal(false);
  private readonly parkedOpen = signal(false);
  // the last parked card dragged out folds the tray
  protected readonly trayOpen = computed(() => this.parkedOpen() && this.parked().length > 0);

  protected toggleAdding(): void {
    this.adding.update(adding => !adding);
  }

  protected openDone(): void {
    this.tabs.openTab('done');
  }

  protected toggleTray(): void {
    this.parkedOpen.set(!this.trayOpen());
  }

  protected open(id: string): void {
    this.tabs.openTab(`direction:${id}`);
  }

  /** a Jira-led direction does not enter another stage's column */
  protected readonly canEnter = (drag: CdkDrag<string>, drop: CdkDropList<Status>): boolean => {
    const direction = this.store.directionById(drag.data);
    return direction === undefined || dropIntent(direction, drop.data) !== null;
  };

  protected cardMoved(directionId: string, event: Pick<CdkDragMove, 'pointerPosition'>): void {
    const todo = this.todoAt(event.pointerPosition.x, event.pointerPosition.y, directionId);
    this.dropHint.show(todo === undefined ? null : { kind: 'todo', todoId: todo.id, directionId });
  }

  protected dropped(event: CdkDragDrop<Status, Status, string>): void {
    if (this.dragCancel.consume()) return;
    if (!event.isPointerOverContainer) {
      const todo = this.todoAt(event.dropPoint.x, event.dropPoint.y, event.item.data);
      if (todo !== undefined) {
        inBackground(this.store.updateTodo(todo.id, { directionId: event.item.data }));
        return;
      }
    }
    const status = event.container.data;
    const direction = this.store.directionById(event.item.data);
    const intent = direction === undefined ? 'move' : dropIntent(direction, status);
    if (intent === null) return;
    if (intent === 'unmark') {
      inBackground(this.store.clearMark(event.item.data));
      return;
    }
    const sameList = event.previousContainer === event.container;
    if (sameList && (status === 'parked' || event.previousIndex === event.currentIndex)) return;
    // the tray does not sort: a direction parked there goes after the others
    const index = status === 'parked' ? this.parked().length : event.currentIndex;
    inBackground(this.store.moveDirection(event.item.data, status, index));
  }

  /** an open todo of another pane under the point that is not linked to this direction yet */
  private todoAt(x: number, y: number, directionId: string): Todo | undefined {
    const id = attributeAt(this.document, x, y, 'data-todo-id');
    const todo = id === null ? undefined : this.store.state().todos.find(item => item.id === id);
    return todo !== undefined && !todo.done && todo.directionId !== directionId ? todo : undefined;
  }
}
