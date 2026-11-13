import type { Daily, Direction, EventKind, EventSource, WorklogState } from '@worklog/model';
import { compareText, localDate, ownDirections, todoLabel } from '@worklog/model';

export interface HistoryEntry {
  kind: 'event' | 'todo';
  at: string;
  text: string;
  direction: Direction | null;
  source: EventSource | null;
  eventKind: EventKind | null;
}

export interface HistoryDay {
  /** local date, YYYY-MM-DD */
  date: string;
  dailies: Daily[];
  entries: HistoryEntry[];
}

function newestFirst(a: { at: string }, b: { at: string }): number {
  return compareText(b.at, a.at);
}

export function buildHistory(state: WorklogState): HistoryDay[] {
  const days = new Map<string, HistoryDay>();
  const day = (iso: string): HistoryDay => {
    const date = localDate(new Date(iso));
    let found = days.get(date);
    if (found === undefined) {
      found = { date, dailies: [], entries: [] };
      days.set(date, found);
    }
    return found;
  };

  // the onboarding example is no work: neither its events nor its done todo
  for (const direction of ownDirections(state.directions)) {
    for (const event of direction.events) {
      day(event.at).entries.push({ kind: 'event', at: event.at, text: event.text, direction, source: event.source, eventKind: event.kind });
    }
  }
  // a done todo with a direction is already there as its todo-done event
  for (const todo of state.todos) {
    if (!todo.done || todo.doneAt === undefined || todo.directionId !== undefined) continue;
    day(todo.doneAt).entries.push({ kind: 'todo', at: todo.doneAt, text: todoLabel(todo), direction: null, source: null, eventKind: null });
  }
  for (const daily of state.dailies) day(daily.heldAt).dailies.push(daily);

  const result = [...days.values()].sort((a, b) => compareText(b.date, a.date));
  for (const item of result) {
    item.entries.sort(newestFirst);
    item.dailies.sort((a, b) => compareText(a.heldAt, b.heldAt));
  }
  return result;
}

function matches(texts: readonly (string | null | undefined)[], needle: string): boolean {
  return texts.some(text => text?.toLowerCase().includes(needle) ?? false);
}

function directionTexts(direction: Direction | null): string[] {
  return direction === null ? [] : [direction.title, ...direction.tickets.map(t => t.key)];
}

export function filterHistory(days: HistoryDay[], query: string): HistoryDay[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return days;
  const result: HistoryDay[] = [];
  for (const day of days) {
    const dailies = day.dailies.filter(d => matches([d.text, ...d.items.flatMap(i => [i.text, i.directionTitle])], needle));
    const entries = day.entries.filter(e => matches([e.text, ...directionTexts(e.direction)], needle));
    if (dailies.length > 0 || entries.length > 0) result.push({ date: day.date, dailies, entries });
  }
  return result;
}
