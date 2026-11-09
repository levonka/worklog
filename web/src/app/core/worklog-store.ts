import { computed, inject, Injectable, signal } from '@angular/core';
import type { AgentRequest, AgentRun, BoardStatus, DailyDraft, Direction, Note, NoteFile, PeriodDigest, Status, WorklogState } from '@worklog/model';
import {
  activeDraft,
  activeRuns,
  clampIndex,
  compareText,
  countEventsAfter,
  currentPeriodStart,
  directionStage,
  EMPTY_STATE,
  localDate,
  moveInList,
  periodDigest,
  placeDirection,
  templateText,
} from '@worklog/model';
import { firstValueFrom } from 'rxjs';
import type { Observable } from 'rxjs';
import type { NoteBody } from './api';
import { ApiClient } from './api';
import { Clock, startOfDay } from './clock';
import { messageOf, NO_CONNECTION } from './error-message';

export interface TodoStats {
  count: number;
  requesters: string[];
}

interface LocalChange {
  before: WorklogState;
  after: WorklogState;
}

@Injectable({ providedIn: 'root' })
export class WorklogStore {
  private readonly api = inject(ApiClient);
  private readonly clock = inject(Clock);
  private readonly current = signal<WorklogState>(EMPTY_STATE);
  // bumped by every refresh: a response to an older one must not overwrite a newer one
  private generation = 0;

  // writes still waiting for an answer: undo comes after them, and a refresh meanwhile may predate them
  private readonly sending = new Set<Promise<unknown>>();

  private readonly loadFailure = signal<string | null>(null);
  private readonly actionFailure = signal<string | null>(null);

  readonly state = this.current.asReadonly();
  readonly loadError = this.loadFailure.asReadonly();
  readonly actionError = this.actionFailure.asReadonly();

  private readonly byOrder = computed(() => [...this.state().directions].sort((a, b) => a.order - b.order));

  readonly columns = computed<Record<BoardStatus, Direction[]>>(() => ({
    in_progress: this.withStatus('in_progress'),
    waiting: this.withStatus('waiting'),
    in_review: this.withStatus('in_review'),
    testing: this.withStatus('testing'),
    awaiting_release: this.withStatus('awaiting_release'),
  }));
  readonly parked = computed(() => this.withStatus('parked'));
  readonly doneDirections = computed(() => this.withStatus('done'));

  readonly openTodos = computed(() => this.state().todos.filter(todo => !todo.done));
  readonly doneToday = computed(() => {
    const today = this.clock.today().getTime();
    return this.state().todos.filter(todo => todo.done && todo.doneAt !== undefined && startOfDay(new Date(todo.doneAt)).getTime() === today);
  });
  readonly todoStats = computed(() => {
    const stats = new Map<string, TodoStats>();
    for (const todo of this.openTodos()) {
      if (todo.directionId === undefined) continue;
      const entry = stats.get(todo.directionId) ?? { count: 0, requesters: [] };
      entry.count++;
      if (todo.requestedBy !== undefined && !entry.requesters.includes(todo.requestedBy)) entry.requesters.push(todo.requestedBy);
      stats.set(todo.directionId, entry);
    }
    return stats;
  });

  /** recomputed at midnight and when a daily is held: the default start depends only on the date */
  readonly periodStart = computed(() => {
    this.clock.today();
    return currentPeriodStart(new Date(), this.state().dailies);
  });
  readonly draft = computed<DailyDraft | null>(() => activeDraft(this.state(), this.periodStart()));
  readonly digest = computed<PeriodDigest>(() => periodDigest(this.state(), this.periodStart(), this.draft()?.summary ?? null, localDate(this.clock.today())));
  readonly textIsTemplate = computed(() => (this.draft()?.text ?? null) === null);
  readonly dailyText = computed(() => this.draft()?.text ?? templateText(this.digest()));
  readonly newEventsAfterText = computed(() => {
    const textAt = this.draft()?.textAt ?? null;
    return this.textIsTemplate() || textAt === null ? 0 : countEventsAfter(this.state(), this.periodStart(), textAt);
  });

  /** newest first */
  readonly notes = computed(() => [...this.state().notes].sort((a, b) => compareText(b.updatedAt, a.updatedAt)));

  readonly activeRuns = computed(() => activeRuns(this.state().runs));

  /** the latest running agent of the direction, its todos' agents included */
  runOfDirection(directionId: string): AgentRun | undefined {
    return this.activeRuns().filter(run => run.directionId === directionId).at(-1);
  }

  runOfTodo(todoId: string): AgentRun | undefined {
    return this.activeRuns().filter(run => run.todoId === todoId).at(-1);
  }

  notesOf(directionId: string): Note[] {
    return this.notes().filter(note => note.directionIds.includes(directionId));
  }

  directionById(id: string): Direction | undefined {
    return this.state().directions.find(direction => direction.id === id);
  }

  dismissProblem(): void {
    this.actionFailure.set(null);
  }

  // never rejects: a failure goes to loadError and the last loaded state stays on screen
  async refresh(): Promise<void> {
    const generation = ++this.generation;
    try {
      const state = await firstValueFrom(this.api.getState());
      // the refresh after the pending writes brings the newer state
      if (generation !== this.generation || this.sending.size > 0) return;
      this.current.set(state);
      this.loadFailure.set(null);
    } catch (error) {
      if (generation === this.generation) this.loadFailure.set(messageOf(error, NO_CONNECTION));
    }
  }

  createDirection(body: { title: string; tickets?: string[] }): Promise<void> {
    return this.send(this.api.createDirection(body));
  }

  renameDirection(id: string, title: string): Promise<void> {
    return this.send(this.api.patchDirection(id, { title }));
  }

  setWaitingFor(id: string, waitingFor: string | null): Promise<void> {
    return this.send(this.api.patchDirection(id, { waitingFor }));
  }

  moveDirection(id: string, status: Status, index: number, waitingFor?: string): Promise<void> {
    const local = this.applyLocally(state => ({ ...state, directions: placeDirection(state.directions, id, status, index) }));
    return this.send(this.api.setStatus(id, waitingFor === undefined ? { status, index } : { status, index, waitingFor }), local);
  }

  /** as on the server: the direction goes to the end of its stage's column */
  clearMark(id: string): Promise<void> {
    const local = this.applyLocally(state => {
      const direction = state.directions.find(d => d.id === id);
      if (direction === undefined) return state;
      const stage = directionStage(direction);
      const end = state.directions.filter(d => d.status === stage && d.id !== id).length;
      return { ...state, directions: placeDirection(state.directions, id, stage, end) };
    });
    return this.send(this.api.clearMark(id), local);
  }

  deleteDirection(id: string): Promise<void> {
    return this.send(this.api.deleteDirection(id));
  }

  addEvent(id: string, text: string): Promise<void> {
    return this.send(this.api.addEvent(id, text));
  }

  addTicket(id: string, key: string): Promise<void> {
    return this.send(this.api.addTicket(id, key));
  }

  removeTicket(id: string, key: string): Promise<void> {
    return this.send(this.api.removeTicket(id, key));
  }

  addLink(id: string, body: { url: string; title?: string }): Promise<void> {
    return this.send(this.api.addLink(id, body));
  }

  setLinkDescription(id: string, url: string, description: string | null): Promise<void> {
    return this.send(this.api.setLinkDescription(id, url, description));
  }

  setQuickLinkDescription(groupId: string, url: string, description: string | null): Promise<void> {
    return this.send(this.api.setQuickLinkDescription(groupId, url, description));
  }

  /** resolves with the new note's id */
  async createNote(body: NoteBody & { title: string }): Promise<string> {
    let id = '';
    await this.send(this.api.createNote(body), undefined, note => (id = note.id));
    return id;
  }

  updateNote(id: string, body: NoteBody): Promise<void> {
    return this.send(this.api.patchNote(id, body));
  }

  deleteNote(id: string): Promise<void> {
    return this.send(this.api.deleteNote(id));
  }

  /** opens a Warp tab with the agent's session */
  startAgent(request: AgentRequest): Promise<void> {
    return this.send(this.api.startAgent(request));
  }

  finishAgent(id: string): Promise<void> {
    return this.send(this.api.finishAgent(id));
  }

  /** in the editor; a refusal (file gone, no editor) goes to actionError like a failed change */
  openFile(file: NoteFile): Promise<void> {
    return this.send(this.api.openFile(file));
  }

  removeLink(id: string, url: string): Promise<void> {
    return this.send(this.api.removeLink(id, url));
  }

  addTodo(body: { text: string; directionId?: string }): Promise<void> {
    return this.send(this.api.addTodo(body));
  }

  updateTodo(id: string, patch: { text?: string; directionId?: string | null; requestedBy?: string | null; due?: string | null }): Promise<void> {
    return this.send(this.api.patchTodo(id, patch));
  }

  setTodoDone(id: string, done: boolean): Promise<void> {
    return this.send(this.api.patchTodo(id, { done }));
  }

  moveTodo(id: string, index: number): Promise<void> {
    const local = this.applyLocally(state => {
      const from = state.todos.findIndex(todo => todo.id === id);
      if (from < 0) return state;
      return { ...state, todos: moveInList(state.todos, from, clampIndex(index, state.todos.length)) };
    });
    return this.send(this.api.moveTodo(id, index), local);
  }

  deleteTodo(id: string): Promise<void> {
    return this.send(this.api.deleteTodo(id));
  }

  addQuickLink(groupTitle: string, title: string, url: string): Promise<void> {
    return this.send(this.api.addQuickLink({ groupTitle, title, url }));
  }

  removeQuickLink(groupId: string, url: string): Promise<void> {
    return this.send(this.api.removeQuickLink(groupId, url));
  }

  /** `periodStart`: the period the text was written for; a stale one is refused by the server */
  setDailyText(text: string | null, periodStart: string = this.periodStart()): Promise<void> {
    return this.send(this.api.setDailyText({ periodStart, text }));
  }

  startSummary(): Promise<void> {
    return this.send(this.api.startSummary());
  }

  removeSummaryItem(id: string): Promise<void> {
    return this.send(this.api.removeSummaryItem(id));
  }

  setSummaryItemDirection(id: string, directionId: string | null): Promise<void> {
    return this.send(this.api.setSummaryItemDirection(id, directionId));
  }

  acceptCandidate(id: string): Promise<void> {
    return this.send(this.api.acceptCandidate(id));
  }

  dismissCandidate(id: string): Promise<void> {
    return this.send(this.api.dismissCandidate(id));
  }

  holdDaily(text: string): Promise<void> {
    return this.send(this.api.holdDaily({ periodStart: this.periodStart(), text }));
  }

  // never rejects: a refusal goes to actionError
  undo(): Promise<void> {
    return this.afterSending(() => this.api.undo());
  }

  redo(): Promise<void> {
    return this.afterSending(() => this.api.redo());
  }

  private async afterSending(request: () => Observable<unknown>): Promise<void> {
    if (this.sending.size > 0) await Promise.allSettled([...this.sending]);
    await this.send(request()).catch(() => undefined);
  }

  private withStatus(status: Status): Direction[] {
    return this.byOrder().filter(direction => direction.status === status);
  }

  private applyLocally(update: (state: WorklogState) => WorklogState): LocalChange {
    const before = this.current();
    const after = update(before);
    this.current.set(after);
    return { before, after };
  }

  // a rejected local change is undone right away (the refresh after it may fail too), unless something newer replaced it
  private async send<T>(request: Observable<T>, local?: LocalChange, onAnswer?: (value: T) => void): Promise<void> {
    const answer = firstValueFrom(request);
    this.sending.add(answer);
    try {
      const value = await answer;
      onAnswer?.(value);
      this.actionFailure.set(null);
    } catch (error) {
      this.actionFailure.set(messageOf(error, 'Не удалось сохранить изменение'));
      if (local !== undefined && this.current() === local.after) this.current.set(local.before);
      throw error;
    } finally {
      this.sending.delete(answer);
      await this.refresh();
    }
  }
}
