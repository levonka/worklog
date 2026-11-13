import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { UpdateCheck, UpdateRun, UpdateStatus } from '@worklog/model';
import { restoreScroll, saveScroll, SCROLL_KEEP_MS, takeScroll } from './scroll-keep';
import { canReloadNow, UPDATE_POLL_MS, UpdateStore } from './update-store';

const GET = { method: 'GET', url: '/api/update' };
const STARTED = '2026-11-13T09:00:00.000Z';
const SCROLL_KEY = 'worklog.scroll.v1';
const RUNNING: UpdateRun = { phase: 'running', startedAt: STARTED, pid: 7 };

function status(version: string, run: UpdateRun | null = null, check: UpdateCheck = 'available'): UpdateStatus {
  return { check, version, run };
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('UpdateStore', () => {
  let updates: UpdateStore;
  let http: HttpTestingController;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    updates = TestBed.inject(UpdateStore);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    sessionStorage.clear();
    try {
      http.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  async function load(answer: UpdateStatus): Promise<void> {
    const loading = updates.load();
    http.expectOne(GET).flush(answer);
    await loading;
  }

  it('loads the status and starts the update, polling until it is over', async () => {
    await load(status('aaa111'));
    expect(updates.status()?.check).toBe('available');
    expect(updates.running()).toBe(false);

    const starting = updates.start();
    expect(updates.running()).toBe(true);
    http.expectOne({ method: 'POST', url: '/api/update' }).flush({ run: { phase: 'running', startedAt: STARTED } }, { status: 202, statusText: 'Accepted' });
    await settle();
    http.expectOne(GET).flush(status('aaa111', RUNNING));
    await starting;
    expect(updates.runningSince()).toBe(STARTED);

    // the server restarts: no answer, the update still runs
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
    http.expectOne(GET).error(new ProgressEvent('error'));
    await settle();
    expect(updates.running()).toBe(true);

    await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
    http.expectOne(GET).flush(status('aaa111', { phase: 'failed', startedAt: STARTED, error: 'сборка не прошла' }));
    await settle();
    expect(updates.running()).toBe(false);

    await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS * 3);
    http.expectNone(GET);
  });

  it('a window opened in the middle of an update follows it by itself', async () => {
    await load(status('aaa111', RUNNING));
    expect(updates.running()).toBe(true);

    await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
    http.expectOne(GET).flush(status('aaa111', RUNNING));
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
    http.expectOne(GET).flush(status('aaa111', { phase: 'failed', startedAt: STARTED, error: 'обновление прервалось' }));
    await settle();

    await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS * 3);
    http.expectNone(GET);
  });

  it('reloads by itself on a new server version when nothing is being edited', async () => {
    // jsdom has no navigation: the reload itself only logs «Not implemented»
    document.body.innerHTML = '<wl-pane data-tab-id="board"><div class="pn__body"></div></wl-pane>';

    await load(status('aaa111', null, 'none'));
    await load(status('aaa111', null, 'none'));
    expect(sessionStorage.getItem(SCROLL_KEY)).toBeNull();

    await load(status('bbb222', { phase: 'done', startedAt: STARTED }, 'none'));
    expect(JSON.parse(sessionStorage.getItem(SCROLL_KEY) ?? 'null')).toEqual({ savedAt: Date.now(), panes: {} });
    expect(updates.reloadWaiting()).toBe(false);
  });

  it('waits with Перезагрузить while a field has focus or a dialog is open', async () => {
    const field = document.createElement('textarea');
    document.body.append(field);
    field.focus();

    await load(status('aaa111', null, 'none'));
    await load(status('bbb222', null, 'none'));
    expect(updates.reloadWaiting()).toBe(true);
    expect(sessionStorage.getItem(SCROLL_KEY)).toBeNull();

    // once waiting, only the click reloads: never behind the user's back
    field.blur();
    await load(status('bbb222', null, 'none'));
    expect(sessionStorage.getItem(SCROLL_KEY)).toBeNull();

    expect(canReloadNow(document)).toBe(true);
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    document.body.append(checkbox);
    checkbox.focus();
    expect(canReloadNow(document)).toBe(true);

    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.append(dialog);
    expect(canReloadNow(document)).toBe(false);

    dialog.remove();
    // an open tray or list cuts nothing short, an open menu does
    document.body.insertAdjacentHTML('beforeend', '<button type="button" aria-expanded="true">Отложено</button>');
    expect(canReloadNow(document)).toBe(true);
    document.body.insertAdjacentHTML('beforeend', '<button type="button" aria-haspopup="menu" aria-expanded="true">Действия</button>');
    expect(canReloadNow(document)).toBe(false);
  });

  it('waits with Перезагрузить while a form keeps typed text, even without focus', async () => {
    const note = document.createElement('textarea');
    document.body.append(note);
    note.value = 'Черновик заметки';
    note.dispatchEvent(new Event('input', { bubbles: true }));

    await load(status('aaa111', null, 'none'));
    await load(status('bbb222', null, 'none'));

    expect(document.activeElement).toBe(document.body);
    expect(updates.reloadWaiting()).toBe(true);
    expect(sessionStorage.getItem(SCROLL_KEY)).toBeNull();

    // sent and emptied, or saving itself, or gone: nothing to lose
    note.value = '';
    const daily = document.createElement('textarea');
    daily.setAttribute('data-autosave', '');
    daily.value = 'Текст дейлика';
    document.body.append(daily);
    const closed = document.createElement('input');
    closed.value = 'закрытая форма';
    expect(canReloadNow(document, [note, daily, closed])).toBe(true);
    note.value = 'Черновик заметки';
    expect(canReloadNow(document, [note])).toBe(false);

    // the tour is a dialog of its own
    note.remove();
    document.body.insertAdjacentHTML('beforeend', '<div role="dialog" aria-modal="true">Экскурсия</div>');
    expect(canReloadNow(document)).toBe(false);
  });

  it('follows a new version only once the update is over, and stops waiting when the old one comes back', async () => {
    const field = document.createElement('input');
    document.body.append(field);

    await load(status('aaa111', null, 'none'));
    // the new server answers, yet its check may still fail and bring the old one back
    await load(status('bbb222', RUNNING, 'none'));
    expect(updates.reloadWaiting()).toBe(false);
    expect(sessionStorage.getItem(SCROLL_KEY)).toBeNull();

    field.focus();
    await load(status('bbb222', { phase: 'done', startedAt: STARTED }, 'none'));
    expect(updates.reloadWaiting()).toBe(true);

    await load(status('aaa111', { phase: 'failed', startedAt: STARTED, error: 'новая версия не запустилась' }, 'available'));
    expect(updates.reloadWaiting()).toBe(false);
  });

  it('turns a failed run into the strip text and dismisses it with DELETE', async () => {
    await load(status('aaa111', { phase: 'failed', startedAt: STARTED, error: 'новая версия не запустилась' }));
    expect(updates.failure()).toBe('Не удалось обновить Worklog: новая версия не запустилась. Осталась прежняя версия, данные не тронуты.');

    const dismissing = updates.dismiss();
    expect(updates.failure()).toBeNull();
    http.expectOne({ method: 'DELETE', url: '/api/update/run' }).flush(null, { status: 204, statusText: 'No Content' });
    await dismissing;

    // a refused start goes to the same strip and away without a request
    const starting = updates.start();
    http.expectOne({ method: 'POST', url: '/api/update' }).flush({ error: 'Нет связи с GitHub — попробуйте позже' }, { status: 409, statusText: 'Conflict' });
    await settle();
    http.expectOne(GET).flush(status('aaa111'));
    await starting;
    expect(updates.running()).toBe(false);
    expect(updates.failure()).toBe('Нет связи с GitHub — попробуйте позже');

    await updates.dismiss();
    expect(updates.failure()).toBeNull();
  });

  it('forgets a refusal once the run it was answered with is over', async () => {
    await load(status('aaa111'));
    const starting = updates.start();
    http.expectOne({ method: 'POST', url: '/api/update' }).flush({ error: 'Обновление уже идёт' }, { status: 409, statusText: 'Conflict' });
    await settle();
    http.expectOne(GET).flush(status('aaa111', RUNNING));
    await starting;
    expect(updates.failure()).toBe('Обновление уже идёт');

    await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
    http.expectOne(GET).flush(status('aaa111', RUNNING));
    await settle();
    expect(updates.failure()).toBe('Обновление уже идёт');

    await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
    http.expectOne(GET).flush(status('aaa111', { ...RUNNING, phase: 'failed', error: 'сборка не прошла' }));
    await settle();
    expect(updates.failure()).toContain('сборка не прошла');
  });

  it('forgets «Новой версии нет» once a later check finds one', async () => {
    await load(status('aaa111'));
    const starting = updates.start();
    http.expectOne({ method: 'POST', url: '/api/update' }).flush({ error: 'Новой версии нет' }, { status: 409, statusText: 'Conflict' });
    await settle();
    http.expectOne(GET).flush(status('aaa111', null, 'none'));
    await starting;
    expect(updates.failure()).toBe('Новой версии нет');

    await load(status('aaa111', null, 'available'));

    expect(updates.failure()).toBeNull();
  });

  it('forgets a refusal once another run comes', async () => {
    await load(status('aaa111'));
    const starting = updates.start();
    http.expectOne({ method: 'POST', url: '/api/update' }).flush({ error: 'Новой версии нет' }, { status: 409, statusText: 'Conflict' });
    await settle();
    http.expectOne(GET).flush(status('aaa111', null, 'none'));
    await starting;
    expect(updates.failure()).toBe('Новой версии нет');

    await load(status('aaa111', { phase: 'failed', startedAt: '2026-11-13T10:00:00.000Z', error: 'не удалось скачать пакеты npm' }));

    expect(updates.failure()).toContain('не удалось скачать пакеты npm');
  });

  it('keeps the scroll of each pane across the reload', () => {
    // each view scrolls its own blocks: the board its columns, the history its body
    const panes = `
      <wl-pane data-tab-id="board"><div class="pn__body"><div class="bd__list"></div><div class="bd__list"></div></div></wl-pane>
      <wl-pane data-tab-id="history"><div class="pn__body"><div class="hv__body"></div></div></wl-pane>
    `;
    document.body.innerHTML = panes;
    const [, column] = document.querySelectorAll('.bd__list');
    const [feed] = document.querySelectorAll('.hv__body');
    column.scrollTop = 120;
    feed.scrollTop = 40;
    feed.scrollLeft = 5;

    saveScroll(document, sessionStorage);
    document.body.innerHTML = panes;
    const history = takeScroll(sessionStorage, 'history');
    const board = takeScroll(sessionStorage, 'board');

    expect(history).toEqual([['div.hv__body#0', 40, 5]]);
    expect(takeScroll(sessionStorage, 'history')).toBeNull();
    expect(takeScroll(sessionStorage, 'todos')).toBeNull();
    const [boardPane, historyPane] = document.querySelectorAll('wl-pane');
    restoreScroll(boardPane, board ?? []);
    restoreScroll(historyPane, history ?? []);
    expect(Array.from(document.querySelectorAll('.bd__list'), list => list.scrollTop)).toEqual([0, 120]);
    expect(document.querySelector('.hv__body')?.scrollTop).toBe(40);
  });

  it('forgets a scroll that no pane took soon after the reload', async () => {
    document.body.innerHTML = '<wl-pane data-tab-id="history"><div class="pn__body"><div class="hv__body"></div></div></wl-pane>';
    const [feed] = document.querySelectorAll('.hv__body');
    feed.scrollTop = 40;
    saveScroll(document, sessionStorage);

    await vi.advanceTimersByTimeAsync(SCROLL_KEEP_MS + 1);

    expect(takeScroll(sessionStorage, 'history')).toBeNull();
    expect(sessionStorage.getItem(SCROLL_KEY)).toBeNull();
  });
});
