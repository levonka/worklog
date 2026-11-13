import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { UpdateCheck, UpdateRun, UpdateStatus } from '@worklog/model';
import { saveScroll, takeScroll } from './scroll-keep';
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
    expect(sessionStorage.getItem(SCROLL_KEY)).toBe('{"board":0}');
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
    document.body.insertAdjacentHTML('beforeend', '<button type="button" aria-expanded="true">Меню</button>');
    expect(canReloadNow(document)).toBe(false);
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

  it('keeps the scroll of each pane across the reload', () => {
    document.body.innerHTML = `
      <wl-pane data-tab-id="board"><div class="pn__body"></div></wl-pane>
      <wl-pane data-tab-id="direction:seo"><div class="pn__body"></div></wl-pane>
    `;
    const [left, right] = document.querySelectorAll('.pn__body');
    left.scrollTop = 120;
    right.scrollTop = 40;

    saveScroll(document, sessionStorage);

    expect(takeScroll(sessionStorage, 'direction:seo')).toBe(40);
    expect(takeScroll(sessionStorage, 'direction:seo')).toBeNull();
    expect(takeScroll(sessionStorage, 'board')).toBe(120);
    expect(takeScroll(sessionStorage, 'todos')).toBeNull();
  });
});
