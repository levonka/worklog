import type { Daily, Direction, Todo, WorkEvent, WorklogState } from '@worklog/model';
import { ticketFromKey } from '@worklog/model';
import { buildHistory, filterHistory } from './history-feed';
import { TEST_PROFILE } from '@worklog/test-profile';

const at = (day: number, hour: number, minute = 0): string => new Date(2026, 10, day, hour, minute).toISOString();

function direction(id: string, title: string, fields: Partial<Direction> = {}): Direction {
  return { id, title, status: 'in_progress', tickets: [], links: [], events: [], order: 0, createdAt: at(1, 9), updatedAt: at(1, 9), ...fields };
}

function event(id: string, when: string, text: string, fields: Partial<WorkEvent> = {}): WorkEvent {
  return { id, at: when, text, source: 'manual', kind: 'note', ...fields };
}

function todo(id: string, fields: Partial<Todo> = {}): Todo {
  return { id, text: id, done: false, createdAt: at(1, 9), ...fields };
}

const DAILY: Daily = {
  id: 'd1',
  heldAt: at(5, 11, 40),
  periodStart: at(4, 11, 30),
  text: 'Касаемо задачи по сео - пообщался с Олегом',
  items: [{ directionId: null, directionTitle: null, text: 'Придумывал worklog', origin: 'summary' }],
};

function state(): WorklogState {
  return {
    directions: [
      direction('seo', 'SEO-текст', {
        tickets: [ticketFromKey('APP-7301', TEST_PROFILE)],
        events: [event('e1', at(4, 14), 'Бэк не отдаёт данные'), event('e2', at(5, 9), 'Завести задачу бэку (от Олега)', { kind: 'todo-done', source: 'system', todoId: 't1' })],
      }),
      direction('red', 'Сертификат', { events: [event('r1', at(5, 10), 'Создал задачу девопсам')] }),
      direction('old', 'Карта', { status: 'done', tickets: [ticketFromKey('APP-6758', TEST_PROFILE)] }),
    ],
    todos: [
      todo('t1', { text: 'Завести задачу бэку', directionId: 'seo', done: true, doneAt: at(5, 9) }),
      todo('t2', { text: 'Ответить Олегу', requestedBy: 'Олега', done: true, doneAt: at(4, 16) }),
      todo('t3', { text: 'Не сделано' }),
    ],
    repeats: [],
    linkGroups: [],
    dailies: [DAILY],
    draft: null,
    notes: [],
    runs: [],
  };
}

describe('history feed', () => {
  it('groups events, todos and dailies by local day, newest first', () => {
    const days = buildHistory(state());
    expect(days.map(d => d.date)).toEqual(['2026-11-05', '2026-11-04']);
    expect(days[0].dailies).toEqual([DAILY]);
    expect(days[0].entries.map(e => [e.kind, e.text, e.direction?.id ?? null])).toEqual([
      ['event', 'Создал задачу девопсам', 'red'],
      ['event', 'Завести задачу бэку (от Олега)', 'seo'],
    ]);
    expect(days[1].entries.map(e => [e.kind, e.text])).toEqual([
      ['todo', 'Ответить Олегу (от Олега)'],
      ['event', 'Бэк не отдаёт данные'],
    ]);
  });

  it('leaves the onboarding example out, events and search alike', () => {
    const example = direction('example', 'Пример: карта пунктов выдачи', { example: true, events: [event('x1', at(5, 8), 'Разобрал BRD'), event('x2', at(5, 12), 'Дело примера', { kind: 'todo-done', source: 'system' })] });
    const days = buildHistory({ ...state(), directions: [...state().directions, example] });
    const texts = days.flatMap(item => item.entries.map(entry => entry.text));
    expect(texts).not.toContain('Разобрал BRD');
    expect(texts).not.toContain('Дело примера');
    expect(filterHistory(days, 'пример')).toEqual([]);
  });

  it('done todo with direction appears once', () => {
    const texts = buildHistory(state()).flatMap(d => d.entries.map(e => e.text));
    expect(texts.filter(text => text.startsWith('Завести задачу бэку'))).toHaveLength(1);
  });

  it('filter by ticket key finds events of that direction', () => {
    const days = filterHistory(buildHistory(state()), ' app-7301 ');
    expect(days.map(d => [d.date, d.dailies.length, d.entries.map(e => e.direction?.id)])).toEqual([
      ['2026-11-05', 0, ['seo']],
      ['2026-11-04', 0, ['seo']],
    ]);
  });

  it('filter by name finds daily text and items', () => {
    expect(filterHistory(buildHistory(state()), 'олег').map(d => [d.date, d.dailies.length, d.entries.length])).toEqual([
      ['2026-11-05', 1, 1],
      ['2026-11-04', 0, 1],
    ]);
    expect(filterHistory(buildHistory(state()), 'worklog').map(d => [d.date, d.dailies.length, d.entries.length])).toEqual([['2026-11-05', 1, 0]]);
  });

  it('empty query keeps everything', () => {
    const days = buildHistory(state());
    expect(filterHistory(days, '  ')).toBe(days);
  });
});
