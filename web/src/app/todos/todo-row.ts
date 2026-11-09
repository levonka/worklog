import { CdkDragHandle } from '@angular/cdk/drag-drop';
import { afterRenderEffect, ChangeDetectionStrategy, Component, computed, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import type { Direction, Todo } from '@worklog/model';
import { BOARD_STATUSES, repeatLabel } from '@worklog/model';
import { runSince } from '../agent/run-since';
import { AgentSheet } from '../core/agent-sheet';
import { Clock, daysBetween } from '../core/clock';
import { DropHint } from '../core/drop-hint';
import { statusDot } from '../core/status-dot';
import { WorklogStore } from '../core/worklog-store';
import { inBackground } from '../core/background';

const MENU_PANELS = ['main', 'direction', 'requester', 'due'] as const;
type MenuPanel = (typeof MENU_PANELS)[number];

const DATE_FORMAT = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short' });
const WEEKDAY_FORMAT = new Intl.DateTimeFormat('ru', { weekday: 'short' });
const DUE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// within this many days the weekday says more than the date
const WEEKDAY_DAYS = 6;
// the menu's max-height: with less room below the row it opens upwards
const MENU_HEIGHT = 320;

interface Due {
  label: string;
  /** today or overdue */
  late: boolean;
}

/** `due` is a local YYYY-MM-DD date; anything else is shown as it is */
export function dueOf(due: string, today: Date): Due {
  const [year, month, day] = due.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (!DUE_PATTERN.test(due) || date.getMonth() !== month - 1 || date.getDate() !== day) return { label: due, late: false };
  const days = daysBetween(today, date);
  return { label: dueLabel(days, date), late: days <= 0 };
}

function dueLabel(days: number, date: Date): string {
  if (days === 0) return 'сегодня';
  if (days === 1) return 'завтра';
  if (days === -1) return 'вчера';
  if (days >= 2 && days <= WEEKDAY_DAYS) return WEEKDAY_FORMAT.format(date);
  return DATE_FORMAT.format(date).replace(/\.$/, '');
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

@Component({
  selector: 'wl-todo-row',
  imports: [CdkDragHandle],
  templateUrl: './todo-row.html',
  styleUrl: './todo-row.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'wl-todo-row',
    '[class.wl-todo-row_done]': 'todo().done',
    '[class.wl-todo-row_target]': 'dropTitle() !== null',
    '[attr.data-todo-id]': 'todo().done ? null : todo().id',
    '[class.wl-todo-row_menu]': 'menu() !== null',
    '(keydown.escape)': 'menu.set(null)',
  },
})
export class TodoRow {
  private readonly store = inject(WorklogStore);
  private readonly clock = inject(Clock);
  private readonly agentSheet = inject(AgentSheet);
  private readonly dropHint = inject(DropHint);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly editor = viewChild<ElementRef<HTMLInputElement>>('editor');
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');

  readonly todo = input.required<Todo>();
  /** off inside a direction's own card, where every todo has that direction */
  readonly showDirection = input(true);

  /** the direction of the card dragged over this row */
  protected readonly dropTitle = computed(() => {
    const target = this.dropHint.target();
    if (target?.kind !== 'todo' || target.todoId !== this.todo().id) return null;
    return this.store.directionById(target.directionId)?.title ?? null;
  });
  protected readonly direction = computed(() => {
    const id = this.todo().directionId;
    return id === undefined ? undefined : this.store.directionById(id);
  });
  protected readonly due = computed(() => {
    const due = this.todo().due;
    return due === undefined ? null : dueOf(due, this.clock.today());
  });
  protected readonly repeat = computed(() => {
    const id = this.todo().repeatId;
    const rule = id === undefined ? undefined : this.store.state().repeats.find(r => r.id === id);
    return rule === undefined ? null : repeatLabel(rule.days);
  });
  protected readonly linkHost = computed(() => {
    const url = this.todo().url;
    return url === undefined ? '' : hostOf(url);
  });
  protected readonly run = computed(() => this.store.runOfTodo(this.todo().id));
  protected readonly runSince = computed(() => {
    const run = this.run();
    return run === undefined ? '' : runSince(run, this.clock.today());
  });
  // the board order, without finished directions
  protected readonly directions = computed(() => {
    const columns = this.store.columns();
    return [...BOARD_STATUSES.flatMap(status => columns[status]), ...this.store.parked()];
  });

  protected readonly editing = signal(false);
  protected readonly menu = signal<MenuPanel | null>(null);
  protected readonly menuUp = signal(false);

  constructor() {
    afterRenderEffect(() => {
      const editor = this.editor()?.nativeElement;
      editor?.focus();
      editor?.select();
    });
    afterRenderEffect(() => this.field()?.nativeElement.focus());
  }

  protected dotOf(direction: Direction): string {
    return statusDot(direction.status);
  }

  protected toggleDone(): void {
    inBackground(this.store.setTodoDone(this.todo().id, !this.todo().done));
  }

  /** Enter and leaving the field save, Escape only closes it */
  protected save(raw: string): void {
    if (!this.editing()) return;
    this.editing.set(false);
    const text = raw.trim();
    if (text === '' || text === this.todo().text) return;
    inBackground(this.store.updateTodo(this.todo().id, { text }));
  }

  protected toggleMenu(): void {
    if (this.menu() !== null) {
      this.menu.set(null);
      return;
    }
    this.menuUp.set(this.roomBelow() < MENU_HEIGHT);
    this.menu.set('main');
  }

  private roomBelow(): number {
    const row = this.host.nativeElement;
    const scroller = row.closest('.pn__body');
    const bottom = scroller === null ? (row.ownerDocument.defaultView?.innerHeight ?? Infinity) : scroller.getBoundingClientRect().bottom;
    return bottom - row.getBoundingClientRect().bottom;
  }

  protected setDirection(directionId: string | null): void {
    this.menu.set(null);
    if (directionId === (this.todo().directionId ?? null)) return;
    inBackground(this.store.updateTodo(this.todo().id, { directionId }));
  }

  protected setRequester(raw: string): void {
    this.menu.set(null);
    const trimmed = raw.trim();
    const requestedBy = trimmed === '' ? null : trimmed;
    if (requestedBy === (this.todo().requestedBy ?? null)) return;
    inBackground(this.store.updateTodo(this.todo().id, { requestedBy }));
  }

  /** a half-typed date reads as '': it must not clear the due date, only «Убрать срок» does */
  protected saveDue(field: HTMLInputElement): void {
    if (field.validity.badInput || field.value === '') return;
    this.setDue(field.value);
  }

  protected setDue(due: string | null): void {
    this.menu.set(null);
    if (due === (this.todo().due ?? null)) return;
    inBackground(this.store.updateTodo(this.todo().id, { due }));
  }

  protected openAgentSheet(): void {
    this.menu.set(null);
    const { id, directionId } = this.todo();
    this.agentSheet.open(directionId === undefined ? { todoId: id } : { todoId: id, directionId });
  }

  protected finishAgent(id: string): void {
    this.menu.set(null);
    inBackground(this.store.finishAgent(id));
  }

  protected remove(): void {
    this.menu.set(null);
    inBackground(this.store.deleteTodo(this.todo().id));
  }
}
