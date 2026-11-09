import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { DailyDraft, Direction, Status, Todo, WorkEvent, WorklogState } from '@worklog/model';
import { WorklogStore } from './worklog-store';

const CREATED_AT = '2026-11-01T09:00:00.000Z';
const STATE_REQUEST = { method: 'GET', url: '/api/state' };

function direction(id: string, status: Status, order: number): Direction {
  return { id, title: `Направление ${id}`, status, tickets: [], links: [], events: [], order, createdAt: CREATED_AT, updatedAt: CREATED_AT };
}

function todo(id: string, fields: Partial<Todo> = {}): Todo {
  return { id, text: `Дело ${id}`, done: false, createdAt: CREATED_AT, ...fields };
}

function worklog(fields: Partial<WorklogState>): WorklogState {
  return { directions: [], todos: [], repeats: [], linkGroups: [], dailies: [], draft: null, notes: [], runs: [], ...fields };
}

function ids(items: readonly { id: string }[]): string[] {
  return items.map(item => item.id);
}

function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve));
}

describe('WorklogStore', () => {
  let store: WorklogStore;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    store = TestBed.inject(WorklogStore);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    vi.useRealTimers();
    // a failed verify would otherwise skip the TestBed reset and break every following test
    try {
      http.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  async function load(state: WorklogState): Promise<void> {
    const loading = store.refresh();
    http.expectOne(STATE_REQUEST).flush(state);
    await loading;
  }

  // the clock reads the time when it is created, so the store is created anew after faking it
  function restartAt(now: Date): void {
    TestBed.resetTestingModule();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(now);
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    store = TestBed.inject(WorklogStore);
    http = TestBed.inject(HttpTestingController);
  }

  async function answerRefresh(state: WorklogState): Promise<void> {
    await settle();
    http.expectOne(STATE_REQUEST).flush(state);
  }

  it('refresh loads state and columns are sorted by order', async () => {
    const state = worklog({
      directions: [
        direction('b', 'in_progress', 1),
        direction('w', 'waiting', 0),
        direction('a', 'in_progress', 0),
        direction('p', 'parked', 0),
        direction('d', 'done', 0),
      ],
    });

    await load(state);

    expect(store.state()).toEqual(state);
    expect(ids(store.columns().in_progress)).toEqual(['a', 'b']);
    expect(ids(store.columns().waiting)).toEqual(['w']);
    expect(store.columns().in_review).toEqual([]);
    expect(store.columns().testing).toEqual([]);
    expect(store.columns().awaiting_release).toEqual([]);
    expect(ids(store.parked())).toEqual(['p']);
    expect(ids(store.doneDirections())).toEqual(['d']);
    expect(store.directionById('w')?.title).toBe('Направление w');
    expect(store.directionById('missing')).toBeUndefined();
  });

  it('todoStats counts open todos and unique requesters', async () => {
    await load(
      worklog({
        directions: [direction('seo', 'in_progress', 0)],
        todos: [
          todo('t1', { directionId: 'seo', requestedBy: 'Олега' }),
          todo('t2', { directionId: 'seo', requestedBy: 'Олега' }),
          todo('t3', { directionId: 'seo', requestedBy: 'Ани', done: true, doneAt: CREATED_AT }),
          todo('t4'),
        ],
      }),
    );

    expect(store.todoStats().get('seo')).toEqual({ count: 2, requesters: ['Олега'] });
    expect(store.todoStats().size).toBe(1);
  });

  it('moveDirection updates columns before the request completes', async () => {
    await load(worklog({ directions: [direction('a', 'in_progress', 0), direction('b', 'in_progress', 1), direction('w', 'waiting', 0)] }));

    const moving = store.moveDirection('a', 'waiting', 1);

    expect(ids(store.columns().in_progress)).toEqual(['b']);
    expect(ids(store.columns().waiting)).toEqual(['w', 'a']);
    const request = http.expectOne({ method: 'POST', url: '/api/directions/a/status' });
    expect(request.request.body).toStrictEqual({ status: 'waiting', index: 1 });
    request.flush(direction('a', 'waiting', 1));
    await answerRefresh(worklog({ directions: [direction('b', 'in_progress', 0), direction('w', 'waiting', 0), direction('a', 'waiting', 1)] }));
    await moving;
    expect(ids(store.columns().waiting)).toEqual(['w', 'a']);
  });

  it('doneToday contains only todos done today', async () => {
    restartAt(new Date(2026, 10, 5, 15, 0));

    await load(
      worklog({
        todos: [
          todo('after-midnight', { done: true, doneAt: new Date(2026, 10, 5, 0, 30).toISOString() }),
          todo('yesterday', { done: true, doneAt: new Date(2026, 10, 4, 23, 30).toISOString() }),
          todo('open'),
          todo('afternoon', { done: true, doneAt: new Date(2026, 10, 5, 14, 0).toISOString() }),
        ],
      }),
    );

    expect(ids(store.doneToday())).toEqual(['after-midnight', 'afternoon']);
    expect(ids(store.openTodos())).toEqual(['open']);
  });

  it('doneToday is recomputed after midnight', async () => {
    restartAt(new Date(2026, 10, 5, 23, 59));
    await load(worklog({ todos: [todo('evening', { done: true, doneAt: new Date(2026, 10, 5, 22, 0).toISOString() })] }));
    expect(ids(store.doneToday())).toEqual(['evening']);

    vi.advanceTimersByTime(2 * 60_000);
    expect(store.doneToday()).toEqual([]);
  });

  it('a refresh that ends while a move is being sent does not undo it', async () => {
    const before = worklog({ directions: [direction('a', 'in_progress', 0), direction('w', 'waiting', 0)] });
    await load(before);

    const moving = store.moveDirection('a', 'waiting', 1);
    const live = store.refresh();
    http.expectOne(STATE_REQUEST).flush(before);
    await live;
    expect(ids(store.columns().waiting)).toEqual(['w', 'a']);

    http.expectOne({ method: 'POST', url: '/api/directions/a/status' }).flush(direction('a', 'waiting', 1));
    await answerRefresh(worklog({ directions: [direction('w', 'waiting', 0), direction('a', 'waiting', 1)] }));
    await moving;
    expect(ids(store.columns().waiting)).toEqual(['w', 'a']);
  });

  it('a move is rolled back when its request and every refresh fail', async () => {
    await load(worklog({ directions: [direction('a', 'in_progress', 0)] }));

    const moving = store.moveDirection('a', 'testing', 0);
    const failed = expect(moving).rejects.toMatchObject({ status: 500 });
    const live = store.refresh();
    http.expectOne(STATE_REQUEST).error(new ProgressEvent('error'));
    await live;
    http.expectOne({ method: 'POST', url: '/api/directions/a/status' }).flush({ error: 'нет' }, { status: 500, statusText: 'Internal Server Error' });
    await settle();
    http.expectOne(STATE_REQUEST).error(new ProgressEvent('error'));

    await failed;
    expect(ids(store.columns().in_progress)).toEqual(['a']);
    expect(store.columns().testing).toEqual([]);
  });

  it('moveTodo reorders todos before the request completes', async () => {
    await load(worklog({ todos: [todo('t1'), todo('t2'), todo('t3')] }));

    const moving = store.moveTodo('t3', 0);

    expect(ids(store.openTodos())).toEqual(['t3', 't1', 't2']);
    const request = http.expectOne({ method: 'POST', url: '/api/todos/t3/move' });
    expect(request.request.body).toStrictEqual({ index: 0 });
    request.flush(null, { status: 204, statusText: 'No Content' });
    await answerRefresh(worklog({ todos: [todo('t3'), todo('t1'), todo('t2')] }));
    await moving;
  });

  it('a refresh started before a local move does not undo it', async () => {
    const before = worklog({ directions: [direction('a', 'in_progress', 0), direction('w', 'waiting', 0)] });
    await load(before);

    const staleRefresh = store.refresh();
    const staleRequest = http.expectOne(STATE_REQUEST);
    const moving = store.moveDirection('a', 'waiting', 1);
    staleRequest.flush(before);
    await staleRefresh;

    expect(ids(store.columns().waiting)).toEqual(['w', 'a']);
    http.expectOne({ method: 'POST', url: '/api/directions/a/status' }).flush(direction('a', 'waiting', 1));
    await answerRefresh(worklog({ directions: [direction('w', 'waiting', 0), direction('a', 'waiting', 1)] }));
    await moving;
  });

  it('a failed move is rolled back by the refresh that follows', async () => {
    const before = worklog({ directions: [direction('a', 'in_progress', 0)] });
    await load(before);

    const moving = store.moveDirection('a', 'testing', 0);
    const failed = expect(moving).rejects.toMatchObject({ status: 400 });
    expect(ids(store.columns().testing)).toEqual(['a']);
    http.expectOne({ method: 'POST', url: '/api/directions/a/status' }).flush({ error: 'нет' }, { status: 400, statusText: 'Bad Request' });
    await answerRefresh(before);

    await failed;
    expect(ids(store.columns().in_progress)).toEqual(['a']);
    expect(store.columns().testing).toEqual([]);
  });

  it('a failed load reports the server error and keeps the last state', async () => {
    const loaded = worklog({ directions: [direction('a', 'in_progress', 0)], todos: [todo('t1')] });
    await load(loaded);

    const reloading = store.refresh();
    http.expectOne(STATE_REQUEST).flush({ error: 'Повреждён файл данных: /d/todos.json' }, { status: 500, statusText: 'Internal Server Error' });

    await expect(reloading).resolves.toBeUndefined();
    expect(store.loadError()).toContain('todos.json');
    expect(store.state()).toEqual(loaded);

    await load(loaded);
    expect(store.loadError()).toBeNull();
  });

  it('a network failure on load reports no connection', async () => {
    const loading = store.refresh();
    http.expectOne(STATE_REQUEST).error(new ProgressEvent('error'));

    await loading;
    expect(store.loadError()).toBe('Нет связи с сервером Worklog');
  });

  it('a failed write is reported until dismissed', async () => {
    const loaded = worklog({ directions: [direction('a', 'in_progress', 0)] });
    await load(loaded);

    const renaming = store.renameDirection('a', '');
    const failed = expect(renaming).rejects.toMatchObject({ status: 400 });
    http.expectOne({ method: 'PATCH', url: '/api/directions/a' }).flush({ error: 'Название: пустое значение' }, { status: 400, statusText: 'Bad Request' });
    await answerRefresh(loaded);
    await failed;
    expect(store.actionError()).toBe('Название: пустое значение');

    await load(loaded);
    expect(store.actionError()).toBe('Название: пустое значение');

    store.dismissProblem();
    expect(store.actionError()).toBeNull();
  });

  it('a write failure without a server message, then the next successful write clears it', async () => {
    const deleting = store.deleteTodo('t1');
    const failed = expect(deleting).rejects.toMatchObject({ status: 0 });
    http.expectOne({ method: 'DELETE', url: '/api/todos/t1' }).error(new ProgressEvent('error'));
    await answerRefresh(worklog({}));
    await failed;
    expect(store.actionError()).toBe('Не удалось сохранить изменение');

    const adding = store.addTodo({ text: 'Дело' });
    http.expectOne({ method: 'POST', url: '/api/todos' }).flush(todo('t2'));
    await answerRefresh(worklog({ todos: [todo('t2')] }));
    await adding;
    expect(store.actionError()).toBeNull();
  });

  it('a failed move whose refresh also fails is rolled back', async () => {
    await load(worklog({ directions: [direction('a', 'in_progress', 0)] }));

    const moving = store.moveDirection('a', 'testing', 0);
    const failed = expect(moving).rejects.toMatchObject({ status: 500 });
    expect(ids(store.columns().testing)).toEqual(['a']);
    http.expectOne({ method: 'POST', url: '/api/directions/a/status' }).flush({ error: 'Повреждён файл данных: /d/todos.json' }, { status: 500, statusText: 'Internal Server Error' });
    await settle();
    http.expectOne(STATE_REQUEST).error(new ProgressEvent('error'));

    await failed;
    expect(ids(store.columns().in_progress)).toEqual(['a']);
    expect(store.columns().testing).toEqual([]);
    expect(store.actionError()).toContain('todos.json');
  });

  interface ActionCase {
    name: string;
    run: (store: WorklogStore) => Promise<void>;
    method: string;
    url: string;
    body: unknown;
    query?: Record<string, string>;
  }

  const actions: ActionCase[] = [
    { name: 'createDirection', run: s => s.createDirection({ title: 'Капча', tickets: ['APP-1'] }), method: 'POST', url: '/api/directions', body: { title: 'Капча', tickets: ['APP-1'] } },
    { name: 'renameDirection', run: s => s.renameDirection('a', 'Сео'), method: 'PATCH', url: '/api/directions/a', body: { title: 'Сео' } },
    { name: 'setWaitingFor', run: s => s.setWaitingFor('a', 'девопсы'), method: 'PATCH', url: '/api/directions/a', body: { waitingFor: 'девопсы' } },
    { name: 'setWaitingFor null', run: s => s.setWaitingFor('a', null), method: 'PATCH', url: '/api/directions/a', body: { waitingFor: null } },
    { name: 'moveDirection with waitingFor', run: s => s.moveDirection('a', 'waiting', 0, 'бэк'), method: 'POST', url: '/api/directions/a/status', body: { status: 'waiting', index: 0, waitingFor: 'бэк' } },
    { name: 'deleteDirection', run: s => s.deleteDirection('a'), method: 'DELETE', url: '/api/directions/a', body: null },
    { name: 'addEvent', run: s => s.addEvent('a', 'Олег подтвердил баг'), method: 'POST', url: '/api/directions/a/events', body: { text: 'Олег подтвердил баг' } },
    { name: 'addTicket', run: s => s.addTicket('a', 'APP-2'), method: 'POST', url: '/api/directions/a/tickets', body: { key: 'APP-2' } },
    { name: 'removeTicket', run: s => s.removeTicket('a', 'APP-2'), method: 'DELETE', url: '/api/directions/a/tickets/APP-2', body: null },
    { name: 'addLink', run: s => s.addLink('a', { url: 'https://figma.com/f', title: 'Макет' }), method: 'POST', url: '/api/directions/a/links', body: { url: 'https://figma.com/f', title: 'Макет' } },
    { name: 'removeLink', run: s => s.removeLink('a', 'https://x.test/p?a=1&b=2'), method: 'DELETE', url: '/api/directions/a/links', body: null, query: { url: 'https://x.test/p?a=1&b=2' } },
    { name: 'addTodo', run: s => s.addTodo({ text: 'Завести задачу', directionId: 'a' }), method: 'POST', url: '/api/todos', body: { text: 'Завести задачу', directionId: 'a' } },
    { name: 'updateTodo', run: s => s.updateTodo('t1', { requestedBy: 'Олега', due: null }), method: 'PATCH', url: '/api/todos/t1', body: { requestedBy: 'Олега', due: null } },
    { name: 'setTodoDone', run: s => s.setTodoDone('t1', true), method: 'PATCH', url: '/api/todos/t1', body: { done: true } },
    { name: 'deleteTodo', run: s => s.deleteTodo('t1'), method: 'DELETE', url: '/api/todos/t1', body: null },
    { name: 'addQuickLink', run: s => s.addQuickLink('Разработка', 'Jenkins', 'https://ci.example.com/'), method: 'POST', url: '/api/link-groups', body: { groupTitle: 'Разработка', title: 'Jenkins', url: 'https://ci.example.com/' } },
    { name: 'removeQuickLink', run: s => s.removeQuickLink('g1', 'https://ci.example.com/'), method: 'DELETE', url: '/api/link-groups/g1/links', body: null, query: { url: 'https://ci.example.com/' } },
    { name: 'undo', run: s => s.undo(), method: 'POST', url: '/api/undo', body: null },
    { name: 'redo', run: s => s.redo(), method: 'POST', url: '/api/redo', body: null },
  ];

  it.each(actions)('$name sends its request and refreshes after the response', async ({ run, method, url, body, query }) => {
    const acting = run(store);

    const request = http.expectOne(req => req.method === method && req.url === url);
    expect(request.request.body).toStrictEqual(body);
    for (const [key, value] of Object.entries(query ?? {})) expect(request.request.params.get(key)).toBe(value);
    expect(http.match(STATE_REQUEST)).toEqual([]);
    request.flush(null);
    await answerRefresh(worklog({}));
    await acting;
  });

  it('undo waits until the changes sent before it got an answer', async () => {
    const renaming = store.renameDirection('a', 'Сео');
    const undoing = store.undo();
    await settle();
    expect(http.match({ method: 'POST', url: '/api/undo' })).toEqual([]);

    http.expectOne({ method: 'PATCH', url: '/api/directions/a' }).flush(null);
    await answerRefresh(worklog({}));
    await renaming;
    await settle();
    http.expectOne({ method: 'POST', url: '/api/undo' }).flush({ applied: true });
    await answerRefresh(worklog({}));
    await undoing;
  });

  it('undo that the server refuses shows its message and does not reject', async () => {
    const undoing = store.undo();
    await settle();
    http
      .expectOne({ method: 'POST', url: '/api/undo' })
      .flush({ error: 'Нельзя отменить: эти данные изменились после этого' }, { status: 409, statusText: 'Conflict' });
    await answerRefresh(worklog({}));

    await expect(undoing).resolves.toBeUndefined();
    expect(store.actionError()).toBe('Нельзя отменить: эти данные изменились после этого');
  });

  describe('daily', () => {
    // Thursday 5 November 2026 at noon; the period starts on Wednesday at 11:30
    const NOW = new Date(2026, 10, 5, 12);
    const PERIOD = new Date(2026, 10, 4, 11, 30).toISOString();
    const at = (hour: number): string => new Date(2026, 10, 5, hour).toISOString();

    function withEvents(...events: WorkEvent[]): WorklogState {
      return worklog({ directions: [{ ...direction('a', 'waiting', 0), title: 'Сторы', events }] });
    }

    function note(id: string, when: string, text: string): WorkEvent {
      return { id, at: when, text, source: 'manual', kind: 'note' };
    }

    // only the date is faked: the requests below wait on real timers
    function restartAtDate(now: Date): void {
      TestBed.resetTestingModule();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now);
      TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
      store = TestBed.inject(WorklogStore);
      http = TestBed.inject(HttpTestingController);
    }

    function draft(fields: Partial<DailyDraft>): DailyDraft {
      return { periodStart: PERIOD, text: null, textAt: null, summary: null, run: null, ...fields };
    }

    it('dailyText follows the template until text is set', async () => {
      restartAt(NOW);
      await load(withEvents(note('e', at(9), 'Разобрал localStorage')));
      expect(store.periodStart()).toBe(PERIOD);
      expect(store.dailyText()).toBe('Касаемо задачи «Сторы»: Разобрал localStorage.');
      expect(store.textIsTemplate()).toBe(true);
      await load({ ...withEvents(note('e', at(9), 'Разобрал localStorage')), draft: draft({ text: 'Своё', textAt: at(10) }) });
      expect(store.dailyText()).toBe('Своё');
      expect(store.textIsTemplate()).toBe(false);
    });

    it('draft of an old period is ignored', async () => {
      restartAt(NOW);
      await load({ ...withEvents(), draft: draft({ periodStart: new Date(2026, 10, 3, 11, 30).toISOString(), text: 'Вчерашнее' }) });
      expect(store.draft()).toBeNull();
      expect(store.dailyText()).toBe('');
    });

    it('newEventsAfterText counts events after textAt', async () => {
      restartAt(NOW);
      const state = withEvents(note('1', at(9), 'до'), note('2', at(11), 'после'));
      await load(state);
      expect(store.newEventsAfterText()).toBe(0);
      await load({ ...state, draft: draft({ text: 'Своё', textAt: at(10) }) });
      expect(store.newEventsAfterText()).toBe(1);
    });

    it('holdDaily posts the shown text with periodStart', async () => {
      restartAtDate(NOW);
      await load(withEvents());
      const holding = store.holdDaily('Текст');
      const request = http.expectOne({ method: 'POST', url: '/api/daily/held' });
      expect(request.request.body).toEqual({ periodStart: PERIOD, text: 'Текст' });
      request.flush({});
      await answerRefresh(withEvents());
      await holding;
    });

    it('setDailyText and startSummary call their routes', async () => {
      restartAtDate(NOW);
      await load(withEvents());
      const saving = store.setDailyText(null);
      const put = http.expectOne({ method: 'PUT', url: '/api/daily/text' });
      expect(put.request.body).toEqual({ periodStart: PERIOD, text: null });
      put.flush({});
      await answerRefresh(withEvents());
      await saving;
      const starting = store.startSummary();
      http.expectOne({ method: 'POST', url: '/api/daily/summary' }).flush({ started: true });
      await answerRefresh(withEvents());
      await starting;
    });
  });
});
