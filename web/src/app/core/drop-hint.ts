import { Injectable, signal } from '@angular/core';

/** what a drag across the panes would land on: a todo under a direction card, or a direction card under a todo */
export type DropTarget = { kind: 'todo'; todoId: string; directionId: string } | { kind: 'direction'; directionId: string };

function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === 'todo') return b.kind === 'todo' && a.todoId === b.todoId && a.directionId === b.directionId;
  return b.kind === 'direction' && a.directionId === b.directionId;
}

/** the nearest `name` attribute among the elements under the point */
export function attributeAt(document: Document, x: number, y: number, name: string): string | null {
  for (const element of document.elementsFromPoint(x, y)) {
    const value = element.closest(`[${name}]`)?.getAttribute(name);
    if (value) return value;
  }
  return null;
}

/** The drop target of the drag in progress, so the row or card under the pointer can mark itself */
@Injectable({ providedIn: 'root' })
export class DropHint {
  // the pointer moves many times over one target: setting the same one again changes nothing
  private readonly current = signal<DropTarget | null>(null, { equal: sameTarget });
  readonly target = this.current.asReadonly();

  show(target: DropTarget | null): void {
    this.current.set(target);
  }

  clear(): void {
    this.current.set(null);
  }
}
