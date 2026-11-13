import { CdkDrag, CdkDropList } from '@angular/cdk/drag-drop';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import type { Direction, Status, Todo, WorklogState } from '@worklog/model';
import { AgentSheet } from '../core/agent-sheet';
import { DragCancel } from '../core/drag-cancel';
import { DropHint } from '../core/drop-hint';
import { WorklogStore } from '../core/worklog-store';
import { canReloadNow } from '../update/update-store';
import { TodoList } from './todo-list';
import { dueOf } from './todo-row';

const AT = '2026-11-01T09:00:00.000Z';
const NOW = new Date(2026, 10, 5, 15, 0);

const SEO_TASK = 'Завести задачу бэку на фикс SEO-текста';
const MR = 'Ответить на комментарии в MR !2741';
const TRANSLATE = 'Доступ к Translate — заявка GLPI #35111';
const SEO_ADMIN = 'Добавить перевод SEO-текста в админку';
const DEVOPS_DONE = 'Создать задачу девопсам через дашборд';

function direction(id: string, title: string, status: Status, order: number): Direction {
  return { id, title, status, tickets: [], links: [], events: [], order, createdAt: AT, updatedAt: AT };
}

function todo(id: string, text: string, fields: Partial<Todo> = {}): Todo {
  return { id, text, done: false, createdAt: AT, ...fields };
}

// the list order is the order of `todos`; done todos sit between the open ones, as they do on disk
const STATE: WorklogState = {
  directions: [
    direction('seo', 'SEO-текст', 'waiting', 0),
    direction('stores', 'Фильтры каталога', 'in_progress', 1),
    direction('unify', 'Переезд сервисов', 'in_progress', 0),
    direction('old', 'Старое направление', 'done', 0),
  ],
  todos: [
    todo('t1', SEO_TASK, { directionId: 'seo', requestedBy: 'Олега', due: '2026-11-03' }),
    todo('d1', DEVOPS_DONE, { directionId: 'seo', done: true, doneAt: new Date(2026, 10, 5, 10, 0).toISOString() }),
    todo('t2', MR, { directionId: 'unify', due: '2026-11-05' }),
    todo('t3', TRANSLATE),
    todo('d0', 'Сделано вчера', { done: true, doneAt: new Date(2026, 10, 4, 18, 0).toISOString() }),
    todo('t4', SEO_ADMIN, { directionId: 'seo', requestedBy: 'Олега', due: '2026-11-09' }),
  ],
  repeats: [],
  linkGroups: [],
  dailies: [],
  draft: null,
  notes: [],
  runs: [],
};

function withTodo(id: string, fields: Partial<Todo>): WorklogState {
  return { ...STATE, todos: STATE.todos.map(item => (item.id === id ? { ...item, ...fields } : item)) };
}

describe('TodoList', () => {
  let fixture: ComponentFixture<TodoList>;
  let http: HttpTestingController;
  let host: HTMLElement;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    TestBed.configureTestingModule({ imports: [TodoList], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(STATE);
    await loading;
    fixture = TestBed.createComponent(TodoList);
    host = fixture.nativeElement;
    await fixture.whenStable();
  });

  afterEach(() => {
    vi.useRealTimers();
    // jsdom has no elementsFromPoint: the drop tests put their own on the document
    Reflect.deleteProperty(document, 'elementsFromPoint');
    try {
      http.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  function query<T extends Element>(selector: string, type: new () => T, root: ParentNode = host): T {
    const element = root.querySelector(selector);
    if (!(element instanceof type)) throw new Error(`${selector} not found`);
    return element;
  }

  function text(element: Element | null): string {
    return (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  function rowTexts(selector: string): string[] {
    return Array.from(host.querySelectorAll(`${selector} .wl-todo-row`)).map(row => text(row.querySelector('.tr__text')));
  }

  const openTexts = (): string[] => rowTexts('.tl__list');
  const doneTexts = (): string[] => rowTexts('.tl__done');

  function row(todoText: string): HTMLElement {
    const found = Array.from(host.querySelectorAll('.wl-todo-row')).find(candidate => text(candidate.querySelector('.tr__text')) === todoText);
    if (!(found instanceof HTMLElement)) throw new Error(`row "${todoText}" not found`);
    return found;
  }

  function menuItems(root: HTMLElement): HTMLButtonElement[] {
    return Array.from(root.querySelectorAll('.tr__item')).filter(item => item instanceof HTMLButtonElement);
  }

  function menuItem(root: HTMLElement, label: string): HTMLButtonElement {
    const item = menuItems(root).find(candidate => text(candidate) === label);
    if (item === undefined) throw new Error(`menu item "${label}" not found`);
    return item;
  }

  async function openMenu(root: HTMLElement, panel?: string): Promise<void> {
    query('.tr__more', HTMLButtonElement, root).click();
    await fixture.whenStable();
    if (panel === undefined) return;
    menuItem(root, panel).click();
    await fixture.whenStable();
  }

  function settle(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve));
  }

  // every write is followed by a state refresh
  async function answerRefresh(state: WorklogState = STATE): Promise<void> {
    await settle();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(state);
    await settle();
    await fixture.whenStable();
  }

  async function expectPatch(id: string, body: object): Promise<void> {
    const request = http.expectOne({ method: 'PATCH', url: `/api/todos/${id}` });
    expect(request.request.body).toStrictEqual(body);
    request.flush({});
    await answerRefresh();
  }

  function press(element: HTMLElement, key: string): void {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  }

  function dropList(): CdkDropList {
    return fixture.debugElement.query(By.directive(CdkDropList)).injector.get(CdkDropList);
  }

  // what CDK emits when the row of `id` is released at `currentIndex`, over the list or elsewhere
  function drop(id: string, previousIndex: number, currentIndex: number, overList: boolean, dropPoint = { x: 0, y: 0 }): void {
    const item = fixture.debugElement
      .queryAll(By.directive(CdkDrag))
      .map(element => element.injector.get(CdkDrag))
      .find(candidate => candidate.data === id);
    if (item === undefined) throw new Error(`drag ${id} not found`);
    const list = dropList();
    list.dropped.emit({
      item,
      previousIndex,
      currentIndex,
      container: list,
      previousContainer: list,
      isPointerOverContainer: overList,
      distance: { x: 400, y: 0 },
      dropPoint,
      event: new MouseEvent('mouseup'),
    });
  }

  function dragRow(id: string) {
    const found = fixture.debugElement.queryAll(By.directive(CdkDrag)).find(element => element.injector.get(CdkDrag).data === id);
    if (found === undefined) throw new Error(`row ${id} not found`);
    return found;
  }

  it('an empty list says how to add a todo; with todos done today it says there are no open ones', async () => {
    expect(host.querySelector('.tl__empty')).toBeNull();
    const store = TestBed.inject(WorklogStore);

    let loading = store.refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush({ ...STATE, todos: STATE.todos.filter(item => item.id === 'd0') });
    await loading;
    await fixture.whenStable();
    expect(text(host.querySelector('.tl__empty'))).toContain('Впишите дело в строку выше');

    loading = store.refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush({ ...STATE, todos: STATE.todos.filter(item => item.id === 'd1') });
    await loading;
    await fixture.whenStable();
    expect(text(host.querySelector('.tl__empty'))).toBe('Открытых дел нет');

    fixture.componentRef.setInput('directionId', 'stores');
    await fixture.whenStable();
    expect(host.querySelector('.tl__empty')).toBeNull();
  });

  it('open rows carry data-todo-id, done rows do not', async () => {
    expect(Array.from(host.querySelectorAll('[data-todo-id]')).map(element => element.getAttribute('data-todo-id'))).toEqual(['t1', 't2', 't3', 't4']);
    host.querySelector<HTMLButtonElement>('.tl__done-toggle')?.click();
    await fixture.whenStable();
    expect(host.querySelectorAll('.wl-todo-row_done').length).toBeGreaterThan(0);
    expect(host.querySelectorAll('.wl-todo-row_done[data-todo-id]')).toHaveLength(0);
  });

  it('dragging a todo over the card of another direction marks the card; over its own card or empty space it does not', () => {
    const hint = TestBed.inject(DropHint);
    const card = document.createElement('div');
    document.body.append(card);
    document.elementsFromPoint = () => [card, document.body];
    try {
      card.setAttribute('data-direction-id', 'unify');
      dragRow('t1').triggerEventHandler('cdkDragMoved', { pointerPosition: { x: 640, y: 120 } });
      expect(hint.target()).toEqual({ kind: 'direction', directionId: 'unify' });
      dragRow('t1').triggerEventHandler('cdkDragEnded', {});
      expect(hint.target()).toBeNull();

      card.setAttribute('data-direction-id', 'seo');
      dragRow('t1').triggerEventHandler('cdkDragMoved', { pointerPosition: { x: 640, y: 120 } });
      expect(hint.target()).toBeNull();

      document.elementsFromPoint = () => [document.body];
      dragRow('t3').triggerEventHandler('cdkDragMoved', { pointerPosition: { x: 640, y: 120 } });
      expect(hint.target()).toBeNull();
    } finally {
      card.remove();
    }
  });

  it('Esc during a todo drag cancels it: the drop that follows changes nothing', () => {
    const card = document.createElement('div');
    card.setAttribute('data-direction-id', 'unify');
    document.body.append(card);
    document.elementsFromPoint = () => [card, document.body];
    try {
      dragRow('t1').triggerEventHandler('cdkDragStarted', {});
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      drop('t1', 0, 2, true);
      dragRow('t1').triggerEventHandler('cdkDragStarted', {});
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      drop('t1', 0, 0, false, { x: 640, y: 120 });

      http.expectNone({ method: 'POST', url: '/api/todos/t1/move' });
      http.expectNone({ method: 'PATCH', url: '/api/todos/t1' });
      expect(openTexts()).toEqual([SEO_TASK, MR, TRANSLATE, SEO_ADMIN]);
    } finally {
      card.remove();
      TestBed.inject(DragCancel).consume();
    }
  });

  it('a row under a dragged card is marked and names the direction', async () => {
    TestBed.inject(DropHint).show({ kind: 'todo', todoId: 't3', directionId: 'unify' });
    await fixture.whenStable();
    expect(Array.from(host.querySelectorAll('.wl-todo-row_target')).map(element => element.getAttribute('data-todo-id'))).toEqual(['t3']);
    expect(host.querySelector('[data-todo-id="t3"] .tr__drop-hint')?.textContent?.trim()).toBe('→ Переезд сервисов');
    expect(host.querySelectorAll('.tr__drop-hint')).toHaveLength(1);
  });

  it('open rows have a six-dot grip, done rows an empty one', async () => {
    const grip = host.querySelector('[data-todo-id="t1"] .tr__grip');
    expect(grip?.getAttribute('title')).toBe('Перетащить в списке или на карточку направления');
    expect(grip?.querySelectorAll('svg circle')).toHaveLength(6);
    host.querySelector<HTMLButtonElement>('.tl__done-toggle')?.click();
    await fixture.whenStable();
    expect(host.querySelector('.wl-todo-row_done .tr__grip')?.childElementCount).toBe(0);
  });

  it('todo text can be selected and copied', () => {
    const texts = Array.from(host.querySelectorAll('.tr__text'));
    expect(texts.length).toBeGreaterThan(0);
    for (const element of texts) expect(element.classList).toContain('wl-selectable');
  });

  it('adds todo on Enter and clears input', async () => {
    const field = query('.tl__new', HTMLInputElement);
    expect(field.placeholder).toBe('＋ Новое дело…');
    field.focus();

    field.value = '   ';
    press(field, 'Enter');
    http.expectNone({ method: 'POST', url: '/api/todos' });

    field.value = '  Пнуть девопсов по INFRA-2208 ';
    press(field, 'Enter');

    const request = http.expectOne({ method: 'POST', url: '/api/todos' });
    expect(request.request.body).toStrictEqual({ text: 'Пнуть девопсов по INFRA-2208' });
    expect(field.value).toBe('');
    expect(document.activeElement).toBe(field);
    request.flush({});
    await answerRefresh();
  });

  it('gives the text back when adding fails', async () => {
    const field = query('.tl__new', HTMLInputElement);
    field.value = 'Пнуть девопсов';
    press(field, 'Enter');

    http.expectOne({ method: 'POST', url: '/api/todos' }).flush({ error: 'Данные заняты' }, { status: 409, statusText: 'Conflict' });
    await answerRefresh();

    expect(field.value).toBe('Пнуть девопсов');
  });

  it('shows direction label and "от Олега"', () => {
    expect(openTexts()).toEqual([SEO_TASK, MR, TRANSLATE, SEO_ADMIN]);

    const seo = row(SEO_TASK);
    expect(text(seo.querySelector('.tr__dir'))).toBe('SEO-текст');
    expect(seo.querySelector('.tr__dir .tr__dot')).not.toBeNull();
    expect(text(seo.querySelector('.tr__who'))).toBe('от Олега');

    const loose = row(TRANSLATE);
    expect(text(loose.querySelector('.tr__tags'))).toBe('без направления');
    expect(loose.querySelector('.tr__dot')).toBeNull();
    expect(loose.querySelector('.tr__who')).toBeNull();
  });

  it('shows the due date, red when it is today or overdue', () => {
    const due = (todoText: string): Element => query('.tr__due', HTMLElement, row(todoText));

    expect(text(due(MR))).toBe('сегодня');
    expect(due(MR).classList).toContain('tr__due_late');
    expect(text(due(SEO_TASK))).toBe('3 нояб');
    expect(due(SEO_TASK).classList).toContain('tr__due_late');
    expect(text(due(SEO_ADMIN))).toBe('пн');
    expect(due(SEO_ADMIN).classList).not.toContain('tr__due_late');
    expect(row(TRANSLATE).querySelector('.tr__due')).toBeNull();
  });

  it('due labels: today, tomorrow, yesterday, a weekday within 6 days, then the date', () => {
    const today = new Date(2026, 10, 5);
    const label = (due: string): string => dueOf(due, today).label;
    expect([label('2026-11-05'), label('2026-11-06'), label('2026-11-04')]).toEqual(['сегодня', 'завтра', 'вчера']);
    expect([label('2026-11-07'), label('2026-11-11')]).toEqual(['сб', 'ср']);
    expect([label('2026-11-12'), label('2026-11-03')]).toEqual(['12 нояб', '3 нояб']);
  });

  it('marks a todo made by a repeat rule with ↻ and its days', async () => {
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush({
      ...withTodo('t3', { repeatId: 'r1' }),
      repeats: [{ id: 'r1', text: TRANSLATE, days: ['mon'], createdAt: NOW.toISOString() }],
    });
    await loading;
    await fixture.whenStable();
    expect(query('.tr__repeat', HTMLElement, row(TRANSLATE)).title).toBe('Повторяется по понедельникам');
    expect(row(MR).querySelector('.tr__repeat')).toBeNull();
  });

  it('shows the time and the link of a todo; the link opens in a new tab', async () => {
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(withTodo('t3', { time: '12:00', url: 'https://meet.example.com/f416' }));
    await loading;
    await fixture.whenStable();
    expect(query('.tr__time', HTMLElement, row(TRANSLATE)).textContent?.trim()).toBe('12:00');
    const link = query('.tr__link', HTMLAnchorElement, row(TRANSLATE));
    expect(link.href).toBe('https://meet.example.com/f416');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener');
    expect(link.textContent?.trim()).toBe('↗ meet.example.com');
    expect(row(MR).querySelector('.tr__link')).toBeNull();
    expect(row(MR).querySelector('.tr__time')).toBeNull();
  });

  it('a malformed due date is shown as it is', async () => {
    expect(dueOf('2026-02-30', new Date(2026, 10, 5))).toEqual({ label: '2026-02-30', late: false });
    expect(dueOf('когда-нибудь', new Date(2026, 10, 5))).toEqual({ label: 'когда-нибудь', late: false });

    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(withTodo('t3', { due: 'когда-нибудь' }));
    await loading;
    await fixture.whenStable();
    expect(text(query('.tr__due', HTMLElement, row(TRANSLATE)))).toBe('когда-нибудь');
    expect(openTexts()).toEqual([SEO_TASK, MR, TRANSLATE, SEO_ADMIN]);
  });

  it('checking a todo calls setTodoDone and moves it to Сделано сегодня', async () => {
    const toggle = query('.tl__done-toggle', HTMLButtonElement);
    expect(text(toggle)).toBe('Сделано сегодня 1');
    expect(doneTexts()).toEqual([]);

    query('.tr__check', HTMLButtonElement, row(SEO_TASK)).click();

    const request = http.expectOne({ method: 'PATCH', url: '/api/todos/t1' });
    expect(request.request.body).toStrictEqual({ done: true });
    request.flush({});
    await answerRefresh(withTodo('t1', { done: true, doneAt: NOW.toISOString() }));

    expect(openTexts()).toEqual([MR, TRANSLATE, SEO_ADMIN]);
    expect(text(toggle)).toBe('Сделано сегодня 2');
    expect(doneTexts()).toEqual([]);

    toggle.click();
    await fixture.whenStable();

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(doneTexts()).toEqual([SEO_TASK, DEVOPS_DONE]);
  });

  it('unchecking a done todo returns it to the list', async () => {
    query('.tl__done-toggle', HTMLButtonElement).click();
    await fixture.whenStable();
    const done = row(DEVOPS_DONE);
    expect(query('.tr__check', HTMLButtonElement, done).getAttribute('aria-checked')).toBe('true');

    query('.tr__check', HTMLButtonElement, done).click();

    const request = http.expectOne({ method: 'PATCH', url: '/api/todos/d1' });
    expect(request.request.body).toStrictEqual({ done: false });
    request.flush({});
    await answerRefresh(withTodo('d1', { done: false, doneAt: undefined }));

    expect(openTexts()).toEqual([SEO_TASK, DEVOPS_DONE, MR, TRANSLATE, SEO_ADMIN]);
    expect(host.querySelector('.tl__done')).toBeNull();
  });

  it('reorders by drop inside the list, at the place of the todo it lands on', async () => {
    drop('t1', 0, 0, true);
    http.expectNone({ method: 'POST', url: '/api/todos/t1/move' });

    // visible [t1, t2, t3, t4] are [0, 2, 3, 5] in the whole list
    drop('t1', 0, 1, true);
    await fixture.whenStable();

    expect(openTexts()).toEqual([MR, SEO_TASK, TRANSLATE, SEO_ADMIN]);
    const request = http.expectOne({ method: 'POST', url: '/api/todos/t1/move' });
    expect(request.request.body).toStrictEqual({ index: 2 });
    request.flush(null, { status: 204, statusText: 'No Content' });
    await answerRefresh();
  });

  it('reorders upwards too', async () => {
    drop('t4', 3, 1, true);
    await fixture.whenStable();

    expect(openTexts()).toEqual([SEO_TASK, SEO_ADMIN, MR, TRANSLATE]);
    const request = http.expectOne({ method: 'POST', url: '/api/todos/t4/move' });
    expect(request.request.body).toStrictEqual({ index: 2 });
    request.flush(null, { status: 204, statusText: 'No Content' });
    await answerRefresh();
  });

  it('drop outside list over element with data-direction-id links the todo', async () => {
    const card = document.createElement('div');
    card.setAttribute('data-direction-id', 'unify');
    const title = document.createElement('span');
    card.append(title);
    document.body.append(card);
    const elementsFromPoint = vi.fn<(x: number, y: number) => Element[]>(() => [title, card, document.body]);
    document.elementsFromPoint = elementsFromPoint;

    try {
      drop('t3', 2, 0, false, { x: 640, y: 120 });

      expect(elementsFromPoint).toHaveBeenCalledWith(640, 120);
      http.expectNone({ method: 'POST', url: '/api/todos/t3/move' });
      await expectPatch('t3', { directionId: 'unify' });
    } finally {
      card.remove();
    }
  });

  it('drop outside the list away from cards, or on its own card, changes nothing', () => {
    const card = document.createElement('div');
    card.setAttribute('data-direction-id', 'seo');
    document.body.append(card);
    let underPointer: Element[] = [document.body];
    document.elementsFromPoint = () => underPointer;

    try {
      drop('t3', 2, 0, false, { x: 640, y: 120 });
      underPointer = [card, document.body];
      drop('t1', 0, 2, false, { x: 640, y: 120 });

      http.expectNone({ method: 'PATCH', url: '/api/todos/t3' });
      http.expectNone({ method: 'PATCH', url: '/api/todos/t1' });
      http.expectNone({ method: 'POST', url: '/api/todos/t1/move' });
      expect(openTexts()).toEqual([SEO_TASK, MR, TRANSLATE, SEO_ADMIN]);
    } finally {
      card.remove();
    }
  });

  it('with directionId input shows only that direction\'s todos', async () => {
    fixture.componentRef.setInput('directionId', 'seo');
    await fixture.whenStable();

    expect(openTexts()).toEqual([SEO_TASK, SEO_ADMIN]);
    expect(host.querySelector('.tr__dir')).toBeNull();
    expect(text(query('.tl__done-toggle', HTMLButtonElement))).toBe('Сделано сегодня 1');

    const field = query('.tl__new', HTMLInputElement);
    field.value = 'Проверить перевод на стенде';
    press(field, 'Enter');
    const request = http.expectOne({ method: 'POST', url: '/api/todos' });
    expect(request.request.body).toStrictEqual({ text: 'Проверить перевод на стенде', directionId: 'seo' });
    request.flush({});
    await answerRefresh();

    fixture.componentRef.setInput('directionId', 'unify');
    await fixture.whenStable();
    expect(openTexts()).toEqual([MR]);
    expect(host.querySelector('.tl__done')).toBeNull();
  });

  it('double click edits the text: Enter and leaving the field save, Escape cancels', async () => {
    const translate = row(TRANSLATE);
    query('.tr__text', HTMLElement, translate).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await fixture.whenStable();

    const editor = query('.tr__edit', HTMLInputElement, translate);
    expect(editor.value).toBe(TRANSLATE);
    expect(document.activeElement).toBe(editor);
    editor.value = '  Доступ к Translate получить ';
    press(editor, 'Enter');
    await fixture.whenStable();

    expect(translate.querySelector('.tr__edit')).toBeNull();
    await expectPatch('t3', { text: 'Доступ к Translate получить' });

    query('.tr__text', HTMLElement, translate).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await fixture.whenStable();
    const again = query('.tr__edit', HTMLInputElement, translate);
    again.value = 'Не то';
    press(again, 'Escape');
    await fixture.whenStable();

    expect(translate.querySelector('.tr__edit')).toBeNull();
    expect(text(translate.querySelector('.tr__text'))).toBe(TRANSLATE);
    http.expectNone({ method: 'PATCH', url: '/api/todos/t3' });

    query('.tr__text', HTMLElement, translate).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await fixture.whenStable();
    const left = query('.tr__edit', HTMLInputElement, translate);
    left.value = 'Доступ к Translate оформить';
    left.dispatchEvent(new FocusEvent('blur'));
    await fixture.whenStable();

    expect(translate.querySelector('.tr__edit')).toBeNull();
    await expectPatch('t3', { text: 'Доступ к Translate оформить' });
  });

  it('menu «Направление ▸» links the todo to a direction or to none', async () => {
    const translate = row(TRANSLATE);
    await openMenu(translate);
    expect(menuItems(translate).map(text)).toEqual(['✦ Поручить агенту', 'Направление ▸', 'Кто попросил', 'Срок', 'Удалить']);

    menuItem(translate, 'Направление ▸').click();
    await fixture.whenStable();
    // the board order, without finished directions
    expect(menuItems(translate).map(text)).toEqual(['Без направления', 'Переезд сервисов', 'Фильтры каталога', 'SEO-текст']);
    expect(menuItem(translate, 'Без направления').classList).toContain('tr__item_current');

    menuItem(translate, 'Фильтры каталога').click();
    await fixture.whenStable();
    expect(translate.querySelector('.tr__menu')).toBeNull();
    await expectPatch('t3', { directionId: 'stores' });

    const seo = row(SEO_TASK);
    await openMenu(seo, 'Направление ▸');
    expect(menuItem(seo, 'SEO-текст').classList).toContain('tr__item_current');
    menuItem(seo, 'Без направления').click();
    await expectPatch('t1', { directionId: null });
  });

  it('menu sets who asked and the due date', async () => {
    const translate = row(TRANSLATE);
    await openMenu(translate, 'Кто попросил');
    const who = query('.tr__menu input', HTMLInputElement, translate);
    expect(document.activeElement).toBe(who);
    who.value = ' Ани ';
    press(who, 'Enter');
    await fixture.whenStable();
    expect(translate.querySelector('.tr__menu')).toBeNull();
    await expectPatch('t3', { requestedBy: 'Ани' });

    const seo = row(SEO_TASK);
    await openMenu(seo, 'Кто попросил');
    const asked = query('.tr__menu input', HTMLInputElement, seo);
    expect(asked.value).toBe('Олега');
    asked.value = '';
    press(asked, 'Enter');
    await expectPatch('t1', { requestedBy: null });

    await openMenu(translate, 'Срок');
    const date = query('.tr__menu input[type="date"]', HTMLInputElement, translate);
    date.value = '2026-11-07';
    press(date, 'Enter');
    await expectPatch('t3', { due: '2026-11-07' });

    await openMenu(seo, 'Срок');
    expect(query('.tr__menu input[type="date"]', HTMLInputElement, seo).value).toBe('2026-11-03');
    menuItem(seo, 'Убрать срок').click();
    await expectPatch('t1', { due: null });
  });

  it('a half-typed or empty date keeps the due date and the menu', async () => {
    const seo = row(SEO_TASK);
    await openMenu(seo, 'Срок');
    const date = query('.tr__menu input[type="date"]', HTMLInputElement, seo);
    date.value = '';
    press(date, 'Enter');
    menuItem(seo, 'Сохранить').click();
    await fixture.whenStable();

    http.expectNone({ method: 'PATCH', url: '/api/todos/t1' });
    expect(seo.querySelector('.tr__menu')).not.toBeNull();
  });

  it('the menu opens upwards when the row is near the bottom of the pane', async () => {
    const pane = document.createElement('div');
    pane.className = 'pn__body';
    document.body.append(pane);
    pane.append(host);
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 600));
    const low = row(SEO_ADMIN);
    const high = row(SEO_TASK);
    vi.spyOn(low, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 500, 400, 40));
    vi.spyOn(high, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 40, 400, 40));

    await openMenu(low);
    expect(query('.tr__menu', HTMLElement, low).classList).toContain('tr__menu_up');
    await openMenu(high);
    expect(query('.tr__menu', HTMLElement, high).classList).not.toContain('tr__menu_up');
    pane.remove();
  });

  it('menu «Удалить» deletes the todo and Escape closes the menu', async () => {
    const translate = row(TRANSLATE);
    await openMenu(translate);
    // the open menu holds back the reload into a new version
    document.body.append(host);
    expect(canReloadNow(document)).toBe(false);
    host.remove();
    press(menuItem(translate, 'Срок'), 'Escape');
    await fixture.whenStable();
    expect(translate.querySelector('.tr__menu')).toBeNull();

    await openMenu(translate);
    menuItem(translate, 'Удалить').click();

    http.expectOne({ method: 'DELETE', url: '/api/todos/t3' }).flush(null, { status: 204, statusText: 'No Content' });
    await answerRefresh({ ...STATE, todos: STATE.todos.filter(item => item.id !== 't3') });
    expect(openTexts()).toEqual([SEO_TASK, MR, SEO_ADMIN]);
  });

  it('hands a todo to the agent and shows the running agent with a way to take the mark off', async () => {
    const seo = row(SEO_ADMIN);
    await openMenu(seo, '✦ Поручить агенту');
    expect(TestBed.inject(AgentSheet).target()).toEqual({ todoId: 't4', directionId: 'seo' });

    const running: WorklogState = {
      ...STATE,
      runs: [{ id: 'r1', template: 'execute', todoId: 't4', directionId: 'seo', branch: 'feature/APP-7301', title: 'x', startedAt: new Date(2026, 10, 5, 14, 20).toISOString() }],
    };
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(running);
    await loading;
    await fixture.whenStable();
    const tag = query('.tr__agent', HTMLElement, row(SEO_ADMIN));
    expect([text(tag), tag.title]).toEqual(['✦ с 14:20', 'Агент работает · ветка feature/APP-7301']);

    await openMenu(row(SEO_ADMIN), 'Снять отметку агента');
    http.expectOne({ method: 'POST', url: '/api/agent/runs/r1/finish' }).flush({});
    await answerRefresh();
  });
});
