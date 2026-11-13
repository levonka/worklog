import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import type { Direction, JiraHealth, Status, Todo, WorkEvent, WorklogState } from '@worklog/model';
import { ticketFromKey } from '@worklog/model';
import { AgentSheet } from '../core/agent-sheet';
import { JiraHealthStore } from '../core/jira-health';
import { ProfileStore } from '../core/profile-store';
import { TabsStore } from '../core/tabs-store';
import { WorklogStore } from '../core/worklog-store';
import { canReloadNow } from '../update/update-store';
import { DirectionView } from './direction-view';
import { TEST_PROFILE } from '@worklog/test-profile';

const AT = '2026-11-01T09:00:00.000Z';
const NOW = new Date(2026, 10, 5, 15, 0);

const BRANCH_URL = 'https://git.example.com/app/-/tree/feature/APP-7301_WEB-4410';
const SRS_URL = 'https://wiki.example.com/pages/viewpage.action?pageId=2050';

function direction(id: string, title: string, status: Status, order: number, fields: Partial<Direction> = {}): Direction {
  return { id, title, status, tickets: [], links: [], events: [], order, createdAt: AT, updatedAt: AT, ...fields };
}

function event(id: string, at: Date, text: string, kind: WorkEvent['kind'] = 'note'): WorkEvent {
  return { id, at: at.toISOString(), text, source: kind === 'status' ? 'system' : 'manual', kind };
}

function todo(id: string, text: string, fields: Partial<Todo> = {}): Todo {
  return { id, text, done: false, createdAt: AT, ...fields };
}

const SEO = direction('seo', 'SEO-текст на страницах товаров', 'waiting', 0, {
  waitingFor: 'бэк',
  tickets: [ticketFromKey('APP-7301', TEST_PROFILE), ticketFromKey('WEB-4410', TEST_PROFILE), ticketFromKey('SHOP-8221', TEST_PROFILE)],
  links: [
    { title: 'feature/APP-7301_WEB-4410', url: BRANCH_URL, kind: 'branch' },
    { title: 'SRS', url: SRS_URL, kind: 'confluence' },
  ],
  // stored oldest first, as the server appends them
  events: [
    event('e1', new Date(2026, 10, 2, 11, 0), 'Фронт закоммичен, бэк не возвращает данные'),
    event('e2', new Date(2026, 10, 4, 18, 30), 'Статус: Жду · бэк', 'status'),
    event('e3', new Date(2026, 10, 5, 14, 20), 'Олег подтвердил: баг бэка'),
  ],
});

const STATE: WorklogState = {
  directions: [
    SEO,
    direction('unify', 'Унификация сервисов', 'in_progress', 0),
    direction('push', 'US пуши', 'testing', 0, { stage: 'testing', stageFromJira: true }),
    direction('toggles', 'Удаление тоглов', 'testing', 1),
  ],
  todos: [
    todo('t1', 'Завести задачу бэку на фикс SEO-текста', { directionId: 'seo', requestedBy: 'Олега' }),
    todo('t2', 'Ответить на комментарии в MR', { directionId: 'unify' }),
    todo('t3', 'Добавить перевод в админку', { directionId: 'seo' }),
  ],
  repeats: [],
  linkGroups: [],
  dailies: [],
  draft: null,
  notes: [],
  runs: [],
};

const WITHOUT_SEO: WorklogState = { ...STATE, directions: STATE.directions.filter(item => item.id !== 'seo') };

describe('DirectionView', () => {
  let fixture: ComponentFixture<DirectionView>;
  let http: HttpTestingController;
  let store: WorklogStore;
  let host: HTMLElement;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    localStorage.clear();
    TestBed.configureTestingModule({ imports: [DirectionView], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    store = TestBed.inject(WorklogStore);
    const profile = TestBed.inject(ProfileStore).load();
    http.expectOne({ method: 'GET', url: '/api/profile' }).flush({ profile: TEST_PROFILE });
    await profile;
    const loading = store.refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(STATE);
    await loading;
    fixture = TestBed.createComponent(DirectionView);
    fixture.componentRef.setInput('directionId', 'seo');
    host = fixture.nativeElement;
    await fixture.whenStable();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
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

  function input(label: string): HTMLInputElement {
    return query(`input[aria-label="${label}"]`, HTMLInputElement);
  }

  function button(selector: string, label: string): HTMLButtonElement {
    const found = Array.from(host.querySelectorAll(selector)).find(candidate => text(candidate) === label);
    if (!(found instanceof HTMLButtonElement)) throw new Error(`button "${label}" not found`);
    return found;
  }

  function press(element: HTMLElement, key: string): void {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
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

  async function expectPatch(body: object): Promise<void> {
    const request = http.expectOne({ method: 'PATCH', url: '/api/directions/seo' });
    expect(request.request.body).toStrictEqual(body);
    request.flush({});
    await answerRefresh();
  }

  it('renders tickets with platform and jira links', async () => {
    const tickets = Array.from(host.querySelectorAll('.dv__ticket')).filter(ticket => ticket instanceof HTMLAnchorElement);
    expect(tickets.map(ticket => [text(ticket), ticket.href, ticket.target, ticket.rel])).toEqual([
      ['APP-7301 App', 'https://jira.example.com/browse/APP-7301', '_blank', 'noopener'],
      ['WEB-4410 Web', 'https://jira.example.com/browse/WEB-4410', '_blank', 'noopener'],
      ['SHOP-8221', 'https://jira.example.com/browse/SHOP-8221', '_blank', 'noopener'],
    ]);

    expect(tickets.map(ticket => ticket.querySelector('img.fv__img')?.getAttribute('src'))).toEqual([
      '/api/favicon?url=https%3A%2F%2Fjira.example.com%2Fbrowse%2FAPP-7301',
      '/api/favicon?url=https%3A%2F%2Fjira.example.com%2Fbrowse%2FWEB-4410',
      '/api/favicon?url=https%3A%2F%2Fjira.example.com%2Fbrowse%2FSHOP-8221',
    ]);

    query('button[aria-label="Убрать WEB-4410"]', HTMLButtonElement).click();
    http.expectOne({ method: 'DELETE', url: '/api/directions/seo/tickets/WEB-4410' }).flush(null);
    await answerRefresh();
  });

  async function loadState(state: WorklogState): Promise<void> {
    const loading = store.refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(state);
    await loading;
    await fixture.whenStable();
  }

  async function loadJira(health: JiraHealth): Promise<void> {
    const loading = TestBed.inject(JiraHealthStore).load();
    http.expectOne({ method: 'GET', url: '/api/jira' }).flush(health);
    await loading;
    await fixture.whenStable();
  }

  function withSeo(fields: Partial<Direction>): WorklogState {
    return { ...STATE, directions: STATE.directions.map(item => (item.id === 'seo' ? { ...item, ...fields } : item)) };
  }

  const refreshLabel = 'button[aria-label="Обновить статусы Jira"]';

  it('shows the Jira status on a ticket chip', async () => {
    const [ms, ...rest] = SEO.tickets;
    await loadState(withSeo({ tickets: [{ ...ms, jira: { status: 'In Review', segments: ['EU'], at: AT } }, ...rest] }));

    const labels = host.querySelectorAll('.dv__jira');
    expect(labels.length).toBe(1);
    expect(text(labels[0])).toBe('In Review');
    expect(labels[0].classList.contains('wl-jira-status_yellow')).toBe(true);
    expect(text(labels[0].closest('.dv__chip'))).toContain('APP-7301');
  });

  it('shows the MRs next to the tickets instead of among the links; ✕ removes every link of one', async () => {
    const mrChips = () =>
      Array.from(host.querySelectorAll('.dv__tickets a.dv__ticket'))
        .filter(chip => chip instanceof HTMLAnchorElement)
        .filter(chip => text(chip.querySelector('.dv__key')).startsWith('MR'));
    expect(mrChips().length).toBe(0);
    const mr = 'https://git.example.com/team/app/-/merge_requests/4022';
    await loadState(withSeo({ links: [...SEO.links, { title: 'MR !4022', url: mr, kind: 'mr' }, { title: 'diffs', url: `${mr}/diffs`, kind: 'mr' }] }));

    const chips = mrChips();
    expect(chips.map(chip => [text(chip.querySelector('.dv__key')), chip.href, chip.title, chip.target, chip.rel, chip.getAttribute('draggable')])).toEqual([
      ['MR !4022', mr, mr, '_blank', 'noopener', 'false'],
    ]);
    expect(chips[0].querySelector('img.fv__img')?.getAttribute('src')).toBe(`/api/favicon?url=${encodeURIComponent(mr)}`);
    expect(Array.from(host.querySelectorAll('.dl__text')).map(text)).toEqual(['feature/APP-7301_WEB-4410', 'SRS']);

    query('button[aria-label="Убрать MR !4022"]', HTMLButtonElement).click();
    for (const url of [mr, `${mr}/diffs`]) {
      await settle();
      const request = http.expectOne(req => req.method === 'DELETE' && req.url === '/api/directions/seo/links');
      expect(request.request.params.get('url')).toBe(url);
      request.flush(null);
      await answerRefresh();
    }
  });

  it('↻ refreshes Jira statuses and waits for the answer', async () => {
    const refresh = query(refreshLabel, HTMLButtonElement);
    expect(refresh.title).toBe('Обновить статусы Jira');
    refresh.click();
    await fixture.whenStable();
    const request = http.expectOne({ method: 'POST', url: '/api/jira/refresh' });
    expect(refresh.disabled).toBe(true);

    request.flush({ state: 'ok', message: null, checkedAt: AT, polling: false });
    await settle();
    await fixture.whenStable();
    expect(refresh.disabled).toBe(false);
  });

  it('↻ is not held by a background poll it did not start', async () => {
    await loadJira({ state: 'ok', message: null, checkedAt: null, polling: true });
    const refresh = query(refreshLabel, HTMLButtonElement);
    expect(refresh.disabled).toBe(false);
    expect(refresh.classList.contains('dv__jira-refresh_busy')).toBe(false);
  });

  it('↻ shows the problem with the time of the last good statuses', async () => {
    await loadJira({ state: 'error', message: 'истёк или неверный токен', checkedAt: new Date(2026, 10, 5, 10, 42).toISOString(), polling: false });
    const refresh = query(refreshLabel, HTMLButtonElement);
    expect(refresh.classList.contains('dv__jira-refresh_problem')).toBe(true);
    expect(refresh.title).toBe('Jira: истёк или неверный токен · статусы на 10:42');

    await loadJira({ state: 'off', message: 'нет сертификата /Users/x/.config/worklog/jira.p12', checkedAt: null, polling: false });
    expect(refresh.title).toBe('Jira: нет сертификата /Users/x/.config/worklog/jira.p12');
  });

  it('shows the branch with a copy button, and stands and builds under it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    expect(text(host.querySelector('wl-branch-line .bl__name'))).toBe('feature/APP-7301_WEB-4410');
    expect(host.querySelector('wl-env-links')).not.toBeNull();
    query('button[aria-label="Скопировать ветку"]', HTMLButtonElement).click();
    await settle();
    expect(writeText).toHaveBeenCalledWith('feature/APP-7301_WEB-4410');
  });

  it('no branch and no stands without tickets of the profile projects', async () => {
    await loadState(withSeo({ tickets: [ticketFromKey('CRM-1190', TEST_PROFILE)] }));

    expect(host.querySelector('wl-branch-line')).toBeNull();
    expect(host.querySelector('wl-env-links')).toBeNull();
  });

  it('a ticket without a link shows as text', async () => {
    await loadState(withSeo({ tickets: [{ key: 'APP-1', platform: 'App', url: '' }] }));

    expect(host.querySelector('a.dv__ticket')).toBeNull();
    expect(text(host.querySelector('span.dv__ticket'))).toBe('APP-1 App');
  });

  it('the example is marked, says it is safe, shows fake tickets as text and deletes itself', async () => {
    await loadState(withSeo({ example: true, tickets: [{ key: 'APP-1001', platform: 'App', url: '' }] }));

    expect(text(host.querySelector('.dv__example'))).toBe('пример');
    expect(text(host.querySelector('.dv__example-note'))).toContain('Это пример');
    expect(host.querySelector('span.dv__ticket')?.getAttribute('title')).toBe('в примере тикет ненастоящий');

    button('.dv__example-remove', 'Удалить пример').click();
    http.expectOne({ method: 'DELETE', url: '/api/directions/seo' }).flush(null);
    await answerRefresh();
  });

  it('an own direction has no example mark', () => {
    expect(host.querySelector('.dv__example')).toBeNull();
    expect(host.querySelector('.dv__example-note')).toBeNull();
  });

  it('without a profile old tickets keep their link and there is no branch or stands', async () => {
    const profile = TestBed.inject(ProfileStore).load();
    http.expectOne({ method: 'GET', url: '/api/profile' }).flush({ profile: null });
    await profile;
    await loadState(withSeo({ tickets: [{ key: 'OLD-1', platform: 'Legacy', url: 'https://old.example.com/browse/OLD-1' }] }));

    const ticket = query('a.dv__ticket', HTMLAnchorElement);
    expect([text(ticket), ticket.getAttribute('href')]).toEqual(['OLD-1 Legacy', 'https://old.example.com/browse/OLD-1']);
    expect(host.querySelector('wl-branch-line')).toBeNull();
    expect(host.querySelector('wl-env-links')).toBeNull();
  });

  it('no ↻ in a done direction', async () => {
    await loadState(withSeo({ status: 'done' }));
    expect(host.querySelector(refreshLabel)).toBeNull();
  });

  it('the title, ticket keys and link titles can be selected and copied', () => {
    const texts = [host.querySelector('.dv__title'), ...host.querySelectorAll('.dv__key'), ...host.querySelectorAll('.dl__text')];
    expect(texts.map(element => element?.className)).toEqual([
      'dv__title wl-selectable',
      'dv__key wl-selectable',
      'dv__key wl-selectable',
      'dv__key wl-selectable',
      'dl__text wl-selectable',
      'dl__text wl-selectable',
    ]);
  });

  it('＋ тикет adds a normalized key and keeps a malformed one without sending it', async () => {
    const field = input('Добавить тикет');
    expect(field.placeholder).toBe('＋ тикет');

    field.value = ' web-6001 ';
    press(field, 'Enter');
    const request = http.expectOne({ method: 'POST', url: '/api/directions/seo/tickets' });
    expect(request.request.body).toStrictEqual({ key: 'WEB-6001' });
    expect(field.value).toBe('');
    request.flush({});
    await answerRefresh();

    field.value = 'капча';
    press(field, 'Enter');
    await fixture.whenStable();
    http.expectNone({ method: 'POST', url: '/api/directions/seo/tickets' });
    expect(field.value).toBe('капча');
    expect(field.classList).toContain('dv__ticket-input_invalid');

    field.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(field.classList).not.toContain('dv__ticket-input_invalid');
  });

  it('adding event on Enter calls addEvent', async () => {
    const addEvent = vi.spyOn(store, 'addEvent');
    const field = input('Что произошло?');
    expect(field.placeholder).toBe('Что произошло?');

    field.value = '   ';
    press(field, 'Enter');
    expect(addEvent).not.toHaveBeenCalled();

    field.value = '  Олег завёл задачу бэку  ';
    press(field, 'Enter');
    expect(addEvent).toHaveBeenCalledExactlyOnceWith('seo', 'Олег завёл задачу бэку');
    expect(field.value).toBe('');
    const request = http.expectOne({ method: 'POST', url: '/api/directions/seo/events' });
    expect(request.request.body).toStrictEqual({ text: 'Олег завёл задачу бэку' });
    request.flush({});
    await answerRefresh();
  });

  it('gives the event text back when saving it fails', async () => {
    const field = input('Что произошло?');
    field.value = 'Олег завёл задачу бэку';
    press(field, 'Enter');

    http.expectOne({ method: 'POST', url: '/api/directions/seo/events' }).flush({ error: 'Данные заняты' }, { status: 409, statusText: 'Conflict' });
    await answerRefresh();

    expect(field.value).toBe('Олег завёл задачу бэку');
  });

  it('feed shows the newest event first, with its day; status changes are grey', () => {
    const events = Array.from(host.querySelectorAll('.ef__event'));
    expect(events.map(item => [text(item.querySelector('.ef__time')), text(item.querySelector('.ef__text'))])).toEqual([
      ['сегодня 14:20', 'Олег подтвердил: баг бэка'],
      ['вчера', 'Статус: Жду · бэк'],
      ['2 нояб', 'Фронт закоммичен, бэк не возвращает данные'],
    ]);
    expect(events.map(item => item.classList.contains('ef__event_status'))).toEqual([false, true, false]);
  });

  it('marks Jira events in the feed', async () => {
    const jiraEvent: WorkEvent = { id: 'j1', at: new Date(2026, 10, 5, 14, 40).toISOString(), text: 'WEB-4410: In CodeReview → Ready For QA', source: 'jira', kind: 'jira-status' };
    await loadState(withSeo({ events: [...SEO.events, jiraEvent] }));

    const events = Array.from(host.querySelectorAll('.ef__event'));
    expect(text(events[0].querySelector('.ef__source'))).toBe('Jira');
    expect(text(events[0].querySelector('.ef__text'))).toBe('WEB-4410: In CodeReview → Ready For QA');
    expect(events.slice(1).every(item => item.querySelector('.ef__source') === null)).toBe(true);
  });

  it('an event with a broken date gets an empty time and the feed still renders', async () => {
    const broken: WorkEvent = { id: 'e4', at: 'вчера вечером', text: 'Без даты', source: 'manual', kind: 'note' };
    const loading = store.refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush({ ...STATE, directions: [{ ...SEO, events: [...SEO.events, broken] }, ...STATE.directions.slice(1)] });
    await loading;
    await fixture.whenStable();

    const [first, ...rest] = Array.from(host.querySelectorAll('.ef__event'));
    expect([text(first.querySelector('.ef__time')), text(first.querySelector('.ef__text'))]).toEqual(['', 'Без даты']);
    expect(rest.length).toBe(3);
  });

  it('ticket and link anchors are not draggable, so the mouse selects their text', () => {
    const anchors = [...host.querySelectorAll('a.dv__ticket'), ...host.querySelectorAll('a.dl__anchor')];
    expect(anchors.length).toBe(5);
    expect(anchors.map(anchor => anchor.getAttribute('draggable'))).toEqual(['false', 'false', 'false', 'false', 'false']);
  });

  it('waitingFor field visible only for waiting', async () => {
    expect(input('Кого жду').value).toBe('бэк');

    fixture.componentRef.setInput('directionId', 'push');
    await fixture.whenStable();
    expect(host.querySelector('input[aria-label="Кого жду"]')).toBeNull();

    fixture.componentRef.setInput('directionId', 'seo');
    await fixture.whenStable();
    button('.dv__status', 'В работе').click();
    await fixture.whenStable();
    expect(host.querySelector('input[aria-label="Кого жду"]')).toBeNull();
    http.expectOne({ method: 'POST', url: '/api/directions/seo/status' }).flush({});
    await answerRefresh();
  });

  it('Кого жду is saved on Enter and on leaving the field, Escape restores it', async () => {
    const field = input('Кого жду');

    field.focus();
    field.value = '  девопсов ';
    press(field, 'Enter');
    await expectPatch({ waitingFor: 'девопсов' });
    expect(document.activeElement).not.toBe(field);

    field.focus();
    field.value = '';
    field.blur();
    await expectPatch({ waitingFor: null });

    field.focus();
    field.value = 'аналитика';
    press(field, 'Escape');
    await fixture.whenStable();
    expect(field.value).toBe('бэк');
    http.expectNone({ method: 'PATCH', url: '/api/directions/seo' });
  });

  it('stage and mark controls', async () => {
    const moveDirection = vi.spyOn(store, 'moveDirection');
    const stages = Array.from(host.querySelectorAll('.dv__status'));
    expect(stages.map(text)).toEqual(['В работе', 'В мерж реквесте', 'Тестирование', 'Ждёт релиза', 'Готово']);
    expect(stages.map(stage => stage.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false', 'false']);
    const marks = Array.from(host.querySelectorAll('.dv__mark'));
    expect(marks.map(text)).toEqual(['Жду', 'Отложено']);
    expect(marks.map(mark => mark.getAttribute('aria-pressed'))).toEqual(['true', 'false']);

    button('.dv__status', 'Тестирование').click();
    expect(moveDirection).toHaveBeenCalledExactlyOnceWith('seo', 'testing', 2);
    const request = http.expectOne({ method: 'POST', url: '/api/directions/seo/status' });
    expect(request.request.body).toEqual({ status: 'testing', index: 2 });
    await fixture.whenStable();
    expect(button('.dv__status', 'Тестирование').getAttribute('aria-pressed')).toBe('true');
    request.flush({});
    await answerRefresh();
  });

  it('stage buttons of a Jira-led direction are disabled with Этап из Jira', async () => {
    fixture.componentRef.setInput('directionId', 'push');
    await fixture.whenStable();

    const stages = Array.from(host.querySelectorAll('.dv__status'));
    expect(stages.every(stage => stage instanceof HTMLButtonElement && stage.disabled && stage.title === 'Этап из Jira')).toBe(true);
    expect(button('.dv__status', 'Тестирование').getAttribute('aria-pressed')).toBe('true');
    expect(button('.dv__mark', 'Жду').disabled).toBe(false);
  });

  it('Жду toggles the mark', async () => {
    button('.dv__mark', 'Жду').click();
    http.expectOne({ method: 'POST', url: '/api/directions/seo/unmark' }).flush({});
    await answerRefresh();

    fixture.componentRef.setInput('directionId', 'unify');
    await fixture.whenStable();
    button('.dv__mark', 'Жду').click();
    const request = http.expectOne({ method: 'POST', url: '/api/directions/unify/status' });
    expect(request.request.body).toEqual({ status: 'waiting', index: 1 });
    request.flush({});
    await answerRefresh();
  });

  it("the header dot has the colour of the direction's status, as its tab does", async () => {
    const dot = query('.dv__dot', HTMLElement);
    expect(dot.style.background).toBe('var(--wl-st-waiting, var(--wl-text-3))');

    button('.dv__status', 'Тестирование').click();
    const request = http.expectOne({ method: 'POST', url: '/api/directions/seo/status' });
    await fixture.whenStable();
    expect(TestBed.inject(TabsStore).view('direction:seo').status).toBe('testing');
    expect(dot.style.background).toBe('var(--wl-st-testing, var(--wl-text-3))');
    request.flush({});
    await answerRefresh();
  });

  it('click on the title renames the direction', async () => {
    query('.dv__title', HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await fixture.whenStable();
    const editor = input('Название направления');
    expect(document.activeElement).toBe(editor);
    expect(editor.value).toBe('SEO-текст на страницах товаров');

    editor.value = 'SEO-текст на товарах';
    press(editor, 'Escape');
    await fixture.whenStable();
    expect(text(host.querySelector('.dv__title'))).toBe('SEO-текст на страницах товаров');
    http.expectNone({ method: 'PATCH', url: '/api/directions/seo' });

    query('.dv__title', HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await fixture.whenStable();
    const again = input('Название направления');
    again.value = '  SEO-текст на товарах ';
    press(again, 'Enter');
    await expectPatch({ title: 'SEO-текст на товарах' });
  });

  it('a click that ends selecting part of the title keeps the selection instead of renaming', async () => {
    const title = query('.dv__title', HTMLElement);
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(title);
    selection?.removeAllRanges();
    selection?.addRange(range);
    try {
      title.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await fixture.whenStable();
      expect(host.querySelector('.dv__title-edit')).toBeNull();
      expect(title.getAttribute('title')).toBe('Нажмите, чтобы переименовать');
    } finally {
      selection?.removeAllRanges();
    }
  });

  it('links show their kind icon and open in Chrome; ✕ removes one', async () => {
    const links = Array.from(host.querySelectorAll('.dl__link'));
    expect(
      links.map(link => {
        const anchor = query('a', HTMLAnchorElement, link);
        return [text(link.querySelector('.dl__icon')), text(link.querySelector('.dl__text')), anchor.href, anchor.target, anchor.rel];
      }),
    ).toEqual([
      ['🌿', 'feature/APP-7301_WEB-4410', BRANCH_URL, '_blank', 'noopener'],
      ['📄', 'SRS', SRS_URL, '_blank', 'noopener'],
    ]);

    query('button[aria-label="Удалить SRS"]', HTMLButtonElement).click();
    const request = http.expectOne(req => req.method === 'DELETE' && req.url === '/api/directions/seo/links');
    expect(request.request.params.get('url')).toBe(SRS_URL);
    request.flush(null);
    await answerRefresh();
  });

  it('adds a link from its url and an optional title', async () => {
    const url = input('Адрес ссылки');
    const title = input('Название ссылки');

    url.value = ' figma.com/design/abc ';
    title.value = ' Макет ';
    press(title, 'Enter');
    const withTitle = http.expectOne({ method: 'POST', url: '/api/directions/seo/links' });
    expect(withTitle.request.body).toStrictEqual({ url: 'https://figma.com/design/abc', title: 'Макет' });
    expect([url.value, title.value]).toEqual(['', '']);
    withTitle.flush({});
    await answerRefresh();

    url.value = 'https://ci.example.com/job/app/812/';
    press(url, 'Enter');
    const bare = http.expectOne({ method: 'POST', url: '/api/directions/seo/links' });
    expect(bare.request.body).toStrictEqual({ url: 'https://ci.example.com/job/app/812/' });
    bare.flush({});
    await answerRefresh();

    title.value = 'Без адреса';
    press(title, 'Enter');
    http.expectNone({ method: 'POST', url: '/api/directions/seo/links' });
  });

  it("lists the direction's todos", () => {
    const rows = Array.from(host.querySelectorAll('.wl-todo-list .wl-todo-row .tr__text'));
    expect(rows.map(text)).toEqual(['Завести задачу бэку на фикс SEO-текста', 'Добавить перевод в админку']);
  });

  it('delete asks inline confirmation then closes tab', async () => {
    const tabs = TestBed.inject(TabsStore);
    tabs.openTab('direction:seo');
    const closeTab = vi.spyOn(tabs, 'closeTab');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    query('.dm__more', HTMLButtonElement).click();
    await fixture.whenStable();
    // the open menu holds back the reload into a new version
    document.body.append(host);
    expect(canReloadNow(document)).toBe(false);
    host.remove();
    button('.dm__item', 'Удалить направление').click();
    await fixture.whenStable();
    expect(text(host.querySelector('.dm__confirm'))).toContain('Удалить «SEO-текст на страницах товаров»?');
    http.expectNone({ method: 'DELETE', url: '/api/directions/seo' });

    button('.dm__btn', 'Отмена').click();
    await fixture.whenStable();
    expect(host.querySelector('.dm__menu')).toBeNull();
    http.expectNone({ method: 'DELETE', url: '/api/directions/seo' });

    query('.dm__more', HTMLButtonElement).click();
    await fixture.whenStable();
    button('.dm__item', 'Удалить направление').click();
    await fixture.whenStable();
    button('.dm__btn', 'Удалить').click();
    http.expectOne({ method: 'DELETE', url: '/api/directions/seo' }).flush(null);
    await answerRefresh(WITHOUT_SEO);

    expect(closeTab).toHaveBeenCalledWith('direction:seo');
    expect(tabs.layout().tabs).not.toContain('direction:seo');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('Escape closes the menu', async () => {
    query('.dm__more', HTMLButtonElement).click();
    await fixture.whenStable();
    expect(host.querySelector('.dm__menu')).not.toBeNull();

    press(query('.dm__item', HTMLButtonElement), 'Escape');
    await fixture.whenStable();
    expect(host.querySelector('.dm__menu')).toBeNull();
  });

  it('✎ on a link opens its description field, ⌘↩ saves it and Esc leaves it as it was', async () => {
    query('button[aria-label="Описание SRS"]', HTMLButtonElement).click();
    await fixture.whenStable();
    const field = query('.dl__desc textarea', HTMLTextAreaElement);
    field.value = 'Требования к SEO-тексту, `seo_block`';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
    await settle();
    const request = http.expectOne({ method: 'PATCH', url: '/api/directions/seo/links' });
    expect(request.request.body).toStrictEqual({ url: SRS_URL, description: 'Требования к SEO-тексту, `seo_block`' });
    request.flush(null);
    const described = { ...STATE, directions: STATE.directions.map(d => (d.id === 'seo' ? { ...SEO, links: [SEO.links[0], { ...SEO.links[1], description: 'Требования' }] } : d)) };
    await answerRefresh(described);
    expect(text(host.querySelector('.dl__desc .wl-rich-text'))).toBe('Требования');

    query('button[aria-label="Описание SRS"]', HTMLButtonElement).click();
    await fixture.whenStable();
    press(query('.dl__desc textarea', HTMLTextAreaElement), 'Escape');
    await fixture.whenStable();
    expect(host.querySelector('.dl__desc textarea')).toBeNull();
    expect(text(host.querySelector('.dl__desc .wl-rich-text'))).toBe('Требования');
  });

  it('opens the task window for the direction and shows a running agent with «Снять отметку»', async () => {
    button('.dv__agent-btn', '✦ Поручить агенту').click();
    expect(TestBed.inject(AgentSheet).target()).toEqual({ directionId: 'seo' });
    expect(host.querySelector('.dv__agent')).toBeNull();

    const running: WorklogState = {
      ...STATE,
      runs: [{ id: 'r1', template: 'execute', directionId: 'seo', branch: 'feature/APP-7301_WEB-4410', title: 'x', startedAt: new Date(2026, 10, 5, 14, 20).toISOString() }],
    };
    const loading = store.refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(running);
    await loading;
    await fixture.whenStable();
    expect(text(host.querySelector('.dv__agent-text'))).toBe('Агент работает · с 14:20 · feature/APP-7301_WEB-4410');

    button('.dv__agent-finish', 'Снять отметку').click();
    http.expectOne({ method: 'POST', url: '/api/agent/runs/r1/finish' }).flush({});
    await answerRefresh();
    expect(host.querySelector('.dv__agent')).toBeNull();
  });
});
