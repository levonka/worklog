import { Injectable, signal } from '@angular/core';

/** a todo's task; a direction's task has no todoId */
export interface AgentTarget {
  directionId?: string;
  todoId?: string;
}

/** The one task window of the app: whoever wants to hand a task over opens it here */
@Injectable({ providedIn: 'root' })
export class AgentSheet {
  private readonly current = signal<AgentTarget | null>(null);

  readonly target = this.current.asReadonly();

  open(target: AgentTarget): void {
    this.current.set(target);
  }

  close(): void {
    this.current.set(null);
  }
}
