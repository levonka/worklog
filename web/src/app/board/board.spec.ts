import { CdkDrag, CdkDropList } from '@angular/cdk/drag-drop';
import type { CdkDragDrop } from '@angular/cdk/drag-drop';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import type { Direction, Status, Todo, WorklogState } from '@worklog/model';
import { ticketFromKey } from '@worklog/model';
import { DragCancel } from '../core/drag-cancel';
import { DropHint } from '../core/drop-hint';
import { ProfileStore } from '../core/profile-store';
import { TabsStore } from '../core/tabs-store';
import { WorklogStore } from '../core/worklog-store';
import { Board } from './board';
import { TEST_PROFILE } from '@worklog/test-profile';

const AT = '2026-11-01T09:00:00.000Z';

function direction(id: string, title: string, status: Status, order: number, fields: Partial<Direction> = {}): Direction {
  return { id, title, status, tickets: [], links: [], events: [], order, createdAt: AT, updatedAt: AT, ...fields };
}

function todo(id: string, fields: Partial<Todo>): Todo {
  return { id, text: `Дело ${id}`, done: false, createdAt: AT, ...fields };
}

const STATE: WorklogState = {
  directions: [
    direction('unify', 'Унификация сервисов', 'in_progress', 1),
    direction('stores', 'Браузерные сторы', 'in_progress', 0, { tickets: [ticketFromKey('APP-9618', TEST_PROFILE), ticketFromKey('WEB-5742', TEST_PROFILE)] }),
    direction('redirect', 'Редирект по UA', 'waiting', 0, { waitingFor: 'девопсы', tickets: [ticketFromKey('SHOP-8221', TEST_PROFILE)] }),
    direction('push', 'US пуши', 'testing', 0, { stage: 'testing', stageFromJira: true }),
    direction('toggles', 'Удаление тоглов', 'awaiting_release', 0),
    direction('captcha', 'Капча', 'parked', 0),
    direction('ident', 'Идентификация', 'parked', 1),
    direction('seo', 'SEO-текст', 'done', 0),
  ],
  todos: [
    todo('t1', { directionId: 'redirect', requestedBy: 'Олега' }),
    todo('t2', { directionId: 'redirect', requestedBy: 'Олега' }),
    todo('t3', { directionId: 'redirect', requestedBy: 'Ани', done: true, doneAt: AT }),
    todo('t4', { directionId: 'unify' }),
  ],
  repeats: [],
  linkGroups: [],
  dailies: [],
  draft: null,
  notes: [],
  runs: [],
};

describe('Board', () => {
  let fixture: ComponentFixture<Board>;
  let http: HttpTestingController;
  let host: HTMLElement;

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({ imports: [Board], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(STATE);
    await loading;
    fixture = TestBed.createComponent(Board);
    host = fixture.nativeElement;
    await fixture.whenStable();
  });

  afterEach(() => {
    localStorage.clear();
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

  function cardIds(root: ParentNode): (string | null)[] {
    return Array.from(root.querySelectorAll('.wl-direction-card')).map(card => card.getAttribute('data-direction-id'));
  }

  function settle(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve));
  }

  // every write is followed by a state refresh
  async function answerRefresh(): Promise<void> {
    await settle();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(STATE);
    await settle();
  }

  function dropList(status: Status): CdkDropList {
    const list = fixture.debugElement
      .queryAll(By.directive(CdkDropList))
      .map(element => element.injector.get(CdkDropList))
      .find(candidate => candidate.data === status);
    if (list === undefined) throw new Error(`drop list ${status} not found`);
    return list;
  }

  // what CDK emits when the card of `id` is dropped at `currentIndex` of the list of `to`
  function drop(id: string, from: Status, to: Status, previousIndex: number, currentIndex: number): void {
    const item = fixture.debugElement.query(By.css(`[data-direction-id="${id}"]`)).injector.get(CdkDrag);
    const event: CdkDragDrop<Status, Status, string> = {
      item,
      previousIndex,
      currentIndex,
      container: dropList(to),
      previousContainer: dropList(from),
      isPointerOverContainer: true,
      distance: { x: 0, y: 120 },
      dropPoint: { x: 10, y: 10 },
      event: new MouseEvent('mouseup'),
    };
    dropList(to).dropped.emit(event);
  }

  // what CDK emits when the card is released away from every list of the board
  function dropOutside(id: string, from: Status, index: number): void {
    const item = fixture.debugElement.query(By.css(`[data-direction-id="${id}"]`)).injector.get(CdkDrag);
    dropList(from).dropped.emit({
      item,
      previousIndex: index,
      currentIndex: index,
      container: dropList(from),
      previousContainer: dropList(from),
      isPointerOverContainer: false,
      distance: { x: -400, y: 0 },
      dropPoint: { x: 640, y: 120 },
      event: new MouseEvent('mouseup'),
    });
  }

  // a todo row of the other pane under the pointer; returns its removal
  function todoUnderPointer(todoId: string): () => void {
    const row = document.createElement('div');
    row.setAttribute('data-todo-id', todoId);
    const text = document.createElement('span');
    row.append(text);
    document.body.append(row);
    document.elementsFromPoint = () => [text, row, document.body];
    return () => row.remove();
  }

  function press(input: HTMLInputElement, key: string): void {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  }

  it('renders five columns with counts', () => {
    const columns = Array.from(host.querySelectorAll('.bd__column'));
    expect(columns.map(column => [text(column.querySelector('.bd__label')), text(column.querySelector('.bd__count'))])).toEqual([
      ['В работе', '2'],
      ['Жду', '1'],
      ['В мерж реквесте', '0'],
      ['Тестирование', '1'],
      ['Ждёт релиза', '1'],
    ]);
    expect(columns.map(column => cardIds(query('.bd__list', HTMLElement, column)))).toEqual([['stores', 'unify'], ['redirect'], [], ['push'], ['toggles']]);
    expect(text(host.querySelector('.bd__title'))).toBe('Доска · 5 активных');
  });

  it('Готово (1) opens done tab', async () => {
    const toggle = query('.bd__done-toggle', HTMLButtonElement);
    expect(text(toggle)).toBe('Готово (1)');
    toggle.click();
    await fixture.whenStable();
    expect(TestBed.inject(TabsStore).layout().active).toBe('done');
  });

  it('card dropped outside the board on an open todo links the todo to that direction', async () => {
    const remove = todoUnderPointer('t4');
    try {
      dropOutside('stores', 'in_progress', 0);
      const request = http.expectOne({ method: 'PATCH', url: '/api/todos/t4' });
      expect(request.request.body).toStrictEqual({ directionId: 'stores' });
      request.flush({});
      await answerRefresh();
      http.expectNone({ method: 'POST', url: '/api/directions/stores/status' });
    } finally {
      remove();
    }
  });

  it('a board with no directions at all says how to start; done ones alone are no new user', async () => {
    expect(host.querySelector('.bd__empty')).toBeNull();

    const store = TestBed.inject(WorklogStore);
    let loading = store.refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush({ ...STATE, directions: [] });
    await loading;
    await fixture.whenStable();
    expect(text(host.querySelector('.bd__empty'))).toContain('«заведи направление');

    loading = store.refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush({ ...STATE, directions: [direction('seo', 'SEO-текст', 'done', 0)] });
    await loading;
    await fixture.whenStable();
    expect(host.querySelector('.bd__empty')).toBeNull();
  });

  it('card dropped on a todo of its own direction, on a done todo or on empty space changes nothing', () => {
    let remove = todoUnderPointer('t1');
    dropOutside('redirect', 'waiting', 0);
    remove();
    remove = todoUnderPointer('t3');
    dropOutside('stores', 'in_progress', 0);
    remove();
    document.elementsFromPoint = () => [document.body];
    dropOutside('stores', 'in_progress', 0);

    http.expectNone({ method: 'PATCH', url: '/api/todos/t1' });
    http.expectNone({ method: 'PATCH', url: '/api/todos/t3' });
    http.expectNone({ method: 'POST', url: '/api/directions/stores/status' });
    http.expectNone({ method: 'POST', url: '/api/directions/redirect/status' });
  });

  it('dragging a card over a todo marks the todo as the drop target until the drag ends', () => {
    const hint = TestBed.inject(DropHint);
    const card = (id: string) => fixture.debugElement.query(By.css(`[data-direction-id="${id}"]`));
    let remove = todoUnderPointer('t4');
    card('stores').triggerEventHandler('cdkDragMoved', { pointerPosition: { x: 640, y: 120 } });
    expect(hint.target()).toEqual({ kind: 'todo', todoId: 't4', directionId: 'stores' });
    card('stores').triggerEventHandler('cdkDragEnded', {});
    expect(hint.target()).toBeNull();
    remove();

    remove = todoUnderPointer('t1');
    card('redirect').triggerEventHandler('cdkDragMoved', { pointerPosition: { x: 640, y: 120 } });
    expect(hint.target()).toBeNull();
    remove();
  });

  it('Esc during a card drag cancels it: the drop that follows changes nothing', () => {
    const card = fixture.debugElement.query(By.css('[data-direction-id="redirect"]'));
    card.triggerEventHandler('cdkDragStarted', {});
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    drop('redirect', 'waiting', 'testing', 0, 1);
    http.expectNone({ method: 'POST', url: '/api/directions/redirect/status' });

    const remove = todoUnderPointer('t4');
    try {
      card.triggerEventHandler('cdkDragStarted', {});
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      dropOutside('redirect', 'waiting', 0);
      http.expectNone({ method: 'PATCH', url: '/api/todos/t4' });
    } finally {
      remove();
      TestBed.inject(DragCancel).consume();
    }
  });

  it('card shows жду: девопсы and badge "2 дела · Олега"', () => {
    const waiting = query('[data-direction-id="redirect"]', HTMLElement);
    expect(text(waiting.querySelector('.dc__title'))).toBe('Редирект по UA');
    expect(text(waiting.querySelector('.dc__meta'))).toBe('SHOP-8221');
    expect(text(waiting.querySelector('.dc__wait'))).toBe('жду: девопсы');
    expect(text(waiting.querySelector('.dc__badge'))).toBe('2 дела · Олега');

    const working = query('[data-direction-id="stores"]', HTMLElement);
    expect(Array.from(working.querySelectorAll('.dc__meta .dc__key')).map(text)).toEqual(['APP-9618', 'WEB-5742']);
    expect(working.querySelector('.dc__wait')).toBeNull();
    expect(working.querySelector('.dc__badge')).toBeNull();
    expect(text(query('[data-direction-id="unify"] .dc__badge', HTMLElement))).toBe('1 дело');
  });

  it('parked tray lists parked titles', async () => {
    const tray = query('.bd__column:first-child .bd__tray', HTMLElement);
    expect(text(query('.bd__tray-head', HTMLButtonElement, tray))).toBe('Отложено · Капча, Идентификация');
    expect(cardIds(tray)).toEqual([]);

    query('.bd__tray-head', HTMLButtonElement, tray).click();
    await fixture.whenStable();

    expect(cardIds(tray)).toEqual(['captcha', 'ident']);
  });

  it('clicking a card opens its tab', async () => {
    query('[data-direction-id="push"]', HTMLElement).click();
    await fixture.whenStable();

    expect(TestBed.inject(TabsStore).layout().active).toBe('direction:push');
  });

  it('moves a card dropped into another column to the drop position', async () => {
    drop('unify', 'in_progress', 'waiting', 1, 0);
    await fixture.whenStable();

    expect(cardIds(query('.bd__column:nth-child(2) .bd__list', HTMLElement))).toEqual(['unify', 'redirect']);
    const request = http.expectOne({ method: 'POST', url: '/api/directions/unify/status' });
    expect(request.request.body).toEqual({ status: 'waiting', index: 0 });
    request.flush({});
    await answerRefresh();
  });

  it('a Jira-led card dropped into another stage column stays and sends nothing', async () => {
    drop('push', 'testing', 'in_review', 0, 0);
    await fixture.whenStable();

    http.expectNone({ method: 'POST', url: '/api/directions/push/status' });
    expect(cardIds(query('.bd__column:nth-child(4) .bd__list', HTMLElement))).toEqual(['push']);
  });

  it('a Jira-led card dragged out of Жду into any stage column clears the mark', async () => {
    const store = TestBed.inject(WorklogStore);
    const loading = store.refresh();
    const redirect = direction('redirect', 'Редирект по UA', 'waiting', 0, { waitingFor: 'девопсы', stage: 'testing', stageFromJira: true });
    http.expectOne({ method: 'GET', url: '/api/state' }).flush({ ...STATE, directions: STATE.directions.map(d => (d.id === 'redirect' ? redirect : d)) });
    await loading;
    await fixture.whenStable();

    drop('redirect', 'waiting', 'in_progress', 0, 0);
    await fixture.whenStable();

    expect(cardIds(query('.bd__column:nth-child(4) .bd__list', HTMLElement))).toEqual(['push', 'redirect']);
    http.expectOne({ method: 'POST', url: '/api/directions/redirect/unmark' }).flush({});
    await answerRefresh();
  });

  it('a Jira-led card can be dropped into Жду', async () => {
    drop('push', 'testing', 'waiting', 0, 1);
    await fixture.whenStable();

    const request = http.expectOne({ method: 'POST', url: '/api/directions/push/status' });
    expect(request.request.body).toEqual({ status: 'waiting', index: 1 });
    request.flush({});
    await answerRefresh();
  });

  it('drops the жду plaque as soon as the card leaves Жду', async () => {
    drop('redirect', 'waiting', 'testing', 0, 1);
    await fixture.whenStable();

    const moved = query('.bd__column:nth-child(4) [data-direction-id="redirect"]', HTMLElement);
    expect(moved.querySelector('.dc__wait')).toBeNull();
    http.expectOne({ method: 'POST', url: '/api/directions/redirect/status' }).flush({});
    await answerRefresh();
  });

  it('reorders cards within a column and ignores a drop back in place', async () => {
    drop('stores', 'in_progress', 'in_progress', 0, 0);
    http.expectNone({ method: 'POST', url: '/api/directions/stores/status' });

    drop('unify', 'in_progress', 'in_progress', 1, 0);
    const request = http.expectOne({ method: 'POST', url: '/api/directions/unify/status' });
    expect(request.request.body).toEqual({ status: 'in_progress', index: 0 });
    request.flush({});
    await answerRefresh();
  });

  async function openTray(): Promise<HTMLElement> {
    const tray = query('.bd__column:first-child .bd__tray', HTMLElement);
    query('.bd__tray-head', HTMLButtonElement, tray).click();
    await fixture.whenStable();
    return tray;
  }

  it('moves a parked card dropped into a column with that column status and index', async () => {
    await openTray();
    drop('captcha', 'parked', 'testing', 0, 1);
    await fixture.whenStable();

    expect(cardIds(query('.bd__column:nth-child(4) .bd__list', HTMLElement))).toEqual(['push', 'captcha']);
    const request = http.expectOne({ method: 'POST', url: '/api/directions/captcha/status' });
    expect(request.request.body).toEqual({ status: 'testing', index: 1 });
    request.flush({});
    await answerRefresh();
  });

  it('the tray folds when its last card is dragged out', async () => {
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush({ ...STATE, directions: STATE.directions.filter(item => item.id !== 'ident') });
    await loading;
    await fixture.whenStable();
    const tray = await openTray();
    expect(tray.classList.contains('bd__tray_open')).toBe(true);

    drop('captcha', 'parked', 'in_progress', 0, 0);
    await fixture.whenStable();

    expect(tray.classList.contains('bd__tray_open')).toBe(false);
    expect(query('.bd__tray-head', HTMLButtonElement, tray).getAttribute('aria-expanded')).toBe('false');
    http.expectOne({ method: 'POST', url: '/api/directions/captcha/status' }).flush({});
    await answerRefresh();
  });

  it('parks a card dropped on the tray after the parked ones', async () => {
    drop('push', 'testing', 'parked', 0, 0);
    await fixture.whenStable();

    expect(text(query('.bd__tray-head', HTMLButtonElement))).toBe('Отложено · Капча, Идентификация, US пуши');
    const request = http.expectOne({ method: 'POST', url: '/api/directions/push/status' });
    expect(request.request.body).toEqual({ status: 'parked', index: 2 });
    request.flush({});
    await answerRefresh();
  });

  it('creates a direction from the ＋ form', async () => {
    query('.bd__add', HTMLButtonElement).click();
    await fixture.whenStable();
    const [title, tickets] = Array.from(host.querySelectorAll('.wl-new-direction-form input')).filter(input => input instanceof HTMLInputElement);
    expect(document.activeElement).toBe(title);

    title.value = '  Капча v2 ';
    tickets.value = 'app-6758  WEB-4023 ';
    press(tickets, 'Enter');

    const request = http.expectOne({ method: 'POST', url: '/api/directions' });
    expect(request.request.body).toEqual({ title: 'Капча v2', tickets: ['APP-6758', 'WEB-4023'] });
    request.flush({});
    await answerRefresh();
    await fixture.whenStable();

    expect(host.querySelector('.wl-new-direction-form')).toBeNull();
  });

  it('the ticket placeholder shows the profile projects', async () => {
    const profile = TestBed.inject(ProfileStore).load();
    http.expectOne({ method: 'GET', url: '/api/profile' }).flush({ profile: TEST_PROFILE });
    await profile;
    query('.bd__add', HTMLButtonElement).click();
    await fixture.whenStable();
    const tickets = query('.wl-new-direction-form input[aria-label="Тикеты через пробел"]', HTMLInputElement);
    expect(tickets.placeholder).toBe('Тикеты через пробел: APP-1234 WEB-1234');
  });

  it('shows the server error and keeps the form open', async () => {
    query('.bd__add', HTMLButtonElement).click();
    await fixture.whenStable();
    const title = query('.wl-new-direction-form input', HTMLInputElement);
    title.value = 'Капча';
    press(title, 'Enter');

    http.expectOne({ method: 'POST', url: '/api/directions' }).flush({ error: 'Данные заняты' }, { status: 409, statusText: 'Conflict' });
    await answerRefresh();
    await fixture.whenStable();

    expect(text(host.querySelector('.ndf__error'))).toBe('Данные заняты');
    expect(host.querySelector('.wl-new-direction-form')).not.toBeNull();
    expect(TestBed.inject(WorklogStore).actionError()).toBeNull();
  });

  it('rejects a malformed ticket key without saving and closes the form on Escape', async () => {
    query('.bd__add', HTMLButtonElement).click();
    await fixture.whenStable();
    const [title, tickets] = Array.from(host.querySelectorAll('.wl-new-direction-form input')).filter(input => input instanceof HTMLInputElement);

    title.value = 'Капча';
    tickets.value = 'APP-6758 капча';
    press(title, 'Enter');
    await fixture.whenStable();

    expect(text(host.querySelector('.ndf__error'))).toBe('Не похоже на ключ задачи: капча');
    http.expectNone({ method: 'POST', url: '/api/directions' });

    press(tickets, 'Escape');
    await fixture.whenStable();
    expect(host.querySelector('.wl-new-direction-form')).toBeNull();
  });
});
