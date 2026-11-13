import { DOCUMENT } from '@angular/common';
import { afterNextRender, ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { WorklogStore } from '../core/worklog-store';
import { Tour } from './tour';
import type { Rect } from './tour-place';
import type { TourDemoKind } from './tour-steps';
import { targetSelector } from './tour-steps';

interface Move {
  text: string;
  /** the ghost's box at the start and at the end, the size of what it stands for */
  from: Rect;
  to: Rect;
  /** first or second half of the loop */
  half: 'first' | 'second' | 'whole';
}

interface Scene {
  moves: Move[];
  /** what the dragged item lands on, lit as in a real drag */
  zones: { rect: Rect; label: string | null; half: Move['half'] }[];
}

/** A drag shown over the window: a cursor carries a ghost of the item; nothing in the data or the layout changes */
@Component({
  selector: 'wl-tour-demo',
  templateUrl: './tour-demo.html',
  styleUrl: './tour-demo.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'wl-tour-demo', '(window:resize)': 'draw()' },
})
export class TourDemo {
  private readonly tour = inject(Tour);
  private readonly worklog = inject(WorklogStore);
  private readonly document = inject(DOCUMENT);

  readonly demo = input.required<TourDemoKind>();

  protected readonly scene = signal<Scene | null>(null);

  constructor() {
    afterNextRender(() => this.draw());
  }

  protected draw(): void {
    this.scene.set(this.demo() === 'todo-card' ? this.todoCard() : this.tabSplit());
  }

  private todoCard(): Scene | null {
    const selector = targetSelector('direction-card', this.tour.directionId());
    const card = selector === null ? null : this.document.querySelector<HTMLElement>(selector);
    const row = this.document.querySelector<HTMLElement>('.tl__list [data-todo-id]');
    const source = row ?? this.document.querySelector<HTMLElement>('[data-tour="todo-input"]');
    if (card === null || source === null) return null;
    const todoId = row?.dataset['todoId'];
    const todoText = this.worklog.state().todos.find(todo => todo.id === todoId)?.text ?? 'Новое дело';
    const directionId = this.tour.directionId();
    const cardText = this.worklog.state().directions.find(direction => direction.id === directionId)?.title ?? '';
    const todoBox = rectOf(source);
    const cardBox = rectOf(card);
    const todoGhost = ghostSize(todoBox);
    const cardGhost = ghostSize(cardBox);
    return {
      moves: [
        { text: todoText, from: centredOn(todoBox, todoGhost), to: centredOn(cardBox, todoGhost), half: 'first' },
        { text: cardText, from: centredOn(cardBox, cardGhost), to: centredOn(todoBox, cardGhost), half: 'second' },
      ],
      zones: [
        { rect: cardBox, label: null, half: 'first' },
        { rect: todoBox, label: null, half: 'second' },
      ],
    };
  }

  private tabSplit(): Scene | null {
    // a tab not on screen is the one worth opening beside the current one
    const tab = this.document.querySelector<HTMLElement>('.tb__tab:not(.tb__tab_on)') ?? this.document.querySelector<HTMLElement>('.tb__tab_on');
    const panes = this.document.querySelector<HTMLElement>('.rt__panes');
    if (tab === null || panes === null) return null;
    const area = rectOf(panes);
    const zone = { left: area.left + (area.width * 2) / 3, top: area.top, width: area.width / 3, height: area.height };
    const tabBox = rectOf(tab);
    return {
      moves: [{ text: tab.querySelector('.tb__title')?.textContent?.trim() ?? '', from: tabBox, to: centredOn(zone, tabBox), half: 'whole' }],
      zones: [{ rect: zone, label: 'Открыть справа', half: 'whole' }],
    };
  }
}

function rectOf(element: HTMLElement): Rect {
  const { left, top, width, height } = element.getBoundingClientRect();
  return { left, top, width, height };
}

// a wide row or card travels as a smaller label, as the drag preview of the board does
function ghostSize(box: Rect): Rect {
  return { ...box, width: Math.min(box.width, 220), height: Math.min(box.height, 44) };
}

function centredOn(box: Rect, ghost: Rect): Rect {
  return { left: box.left + box.width / 2 - ghost.width / 2, top: box.top + box.height / 2 - ghost.height / 2, width: ghost.width, height: ghost.height };
}
