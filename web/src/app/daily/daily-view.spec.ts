import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import type { DailyDraft, Direction, SessionSummary, WorkEvent, WorklogState } from '@worklog/model';
import { ticketFromKey } from '@worklog/model';
import { TabsStore } from '../core/tabs-store';
import { WorklogStore } from '../core/worklog-store';
import { UpdateStore } from '../update/update-store';
import { DailyView } from './daily-view';
import { TEST_PROFILE } from '@worklog/test-profile';

// Thursday 5 November 2026 at 11:05; the period starts on Wednesday at 11:30
const NOW = new Date(2026, 10, 5, 11, 5);
const PERIOD = new Date(2026, 10, 4, 11, 30).toISOString();
const at = (day: number, hour: number, minute = 0): string => new Date(2026, 10, day, hour, minute).toISOString();

function direction(id: string, title: string, fields: Partial<Direction> = {}): Direction {
  return { id, title, status: 'in_progress', tickets: [], links: [], events: [], order: 0, createdAt: at(1, 9), updatedAt: at(1, 9), ...fields };
}

function event(id: string, when: string, text: string, kind: WorkEvent['kind'] = 'note'): WorkEvent {
  return { id, at: when, text, source: kind === 'status' ? 'system' : 'manual', kind };
}

const SUMMARY: SessionSummary = {
  ranAt: at(5, 10),
  sessionCount: 3,
  items: [
    { id: 'i1', sessionId: 's1', at: at(5, 9), directionId: 'seo', text: 'Проверил ответ стенда' },
    { id: 'i2', sessionId: 's2', at: at(5, 9), directionId: null, text: 'Придумывал сервис учёта задач' },
  ],
  candidates: [{ id: 'c1', sessionId: 's1', text: 'Завести задачу бэку', requestedBy: 'Олега', directionId: 'seo' }],
};

function draft(fields: Partial<DailyDraft> = {}): DailyDraft {
  return { periodStart: PERIOD, text: null, textAt: null, summary: SUMMARY, run: null, ...fields };
}

function state(draftValue: DailyDraft | null): WorklogState {
  return {
    directions: [
      direction('seo', 'SEO-текст', {
        status: 'waiting',
        waitingFor: 'бэк',
        tickets: [ticketFromKey('APP-7301', TEST_PROFILE)],
        events: [event('e1', at(4, 14), 'Олег подтвердил баг бэка'), event('e2', at(4, 14, 5), 'Статус: Жду · бэк', 'status')],
      }),
      direction('red', 'Сертификат', { status: 'waiting', waitingFor: 'девопсы', events: [event('r', at(3, 10), 'Статус: Жду · девопсы', 'status')] }),
    ],
    todos: [],
    repeats: [],
    linkGroups: [],
    dailies: [],
    draft: draftValue,
    notes: [],
    runs: [],
  };
}

describe('DailyView', () => {
  let fixture: ComponentFixture<DailyView>;
  let http: HttpTestingController;
  let host: HTMLElement;

  async function setup(draftValue: DailyDraft | null, now: Date = NOW): Promise<void> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    localStorage.clear();
    TestBed.configureTestingModule({ imports: [DailyView], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(state(draftValue));
    await loading;
    fixture = TestBed.createComponent(DailyView);
    host = fixture.nativeElement;
    await fixture.whenStable();
  }

  afterEach(() => {
    vi.useRealTimers();
    try {
      http.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  function texts(selector: string): string[] {
    return Array.from(host.querySelectorAll(selector)).map(node => node.textContent?.replace(/\s+/g, ' ').trim() ?? '');
  }

  function button(text: string, root: ParentNode = host): HTMLButtonElement {
    const found = Array.from(root.querySelectorAll('button')).find(node => node.textContent?.trim() === text);
    if (!found) throw new Error(`Нет кнопки «${text}»`);
    return found;
  }

  async function answerRefresh(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve));
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(state(draft()));
  }

  it('shows the daily date, time left and the period', async () => {
    await setup(draft());
    expect(texts('.dly__title')).toEqual(['Дейлик чт, 5 ноября · через 25 мин']);
    expect(texts('.dly__period')).toEqual(['Период ср 11:30 → сейчас · 2 события · 3 сессии']);
  });

  it('renders groups with ✎ events and ✦ items', async () => {
    await setup(draft());
    expect(texts('.dly__group-title')).toEqual(['SEO-текст']);
    const lines = Array.from(host.querySelectorAll('.dly__group:not(.dly__unbound) .dly__line'));
    expect(lines.map(line => `${line.querySelector('.dly__src')?.textContent} ${line.querySelector('.dly__line-text')?.textContent}`)).toEqual([
      '✎ Олег подтвердил баг бэка',
      '✎ Статус: Жду · бэк',
      '✦ Проверил ответ стенда',
    ]);
    expect(host.querySelector('.dly__line_status')?.textContent).toContain('Статус: Жду · бэк');
  });

  it('unbound block lists items without direction', async () => {
    await setup(draft());
    expect(texts('.dly__unbound .dly__line-text')).toEqual(['Придумывал сервис учёта задач']);
  });

  it('removing and rebinding an item calls the store', async () => {
    await setup(draft());
    const line = host.querySelectorAll('.dly__line_summary')[0];
    button('✕', line).click();
    http.expectOne({ method: 'DELETE', url: '/api/daily/items/i1' }).flush(null);
    await answerRefresh();

    const select = host.querySelector<HTMLSelectElement>('.dly__unbound .dly__bind');
    if (!select) throw new Error('нет выбора направления');
    select.value = 'seo';
    select.dispatchEvent(new Event('change'));
    const patch = http.expectOne({ method: 'PATCH', url: '/api/daily/items/i2' });
    expect(patch.request.body).toEqual({ directionId: 'seo' });
    patch.flush({});
    await answerRefresh();
  });

  it('candidate «В дела» calls acceptCandidate and ✕ dismisses it', async () => {
    await setup(draft());
    expect(texts('.dly__candidate-text')).toEqual(['Завести задачу бэку · от Олега · SEO-текст']);
    button('В дела').click();
    http.expectOne({ method: 'POST', url: '/api/daily/candidates/c1/accept' }).flush({});
    await answerRefresh();
    button('✕', host.querySelector('.dly__candidate') ?? host).click();
    http.expectOne({ method: 'DELETE', url: '/api/daily/candidates/c1' }).flush(null);
    await answerRefresh();
  });

  it('waiting shows days since status change', async () => {
    await setup(draft());
    expect(texts('.dly__waiting-item')).toEqual(['Сертификат — девопсы · 2 дн.', 'SEO-текст — бэк · 1 дн.']);
  });

  it('summary button starts a run', async () => {
    await setup(null);
    button('✦ Собрать из сессий').click();
    http.expectOne({ method: 'POST', url: '/api/daily/summary' }).flush({ started: true });
    await answerRefresh();
  });

  it('summary button is disabled and shows elapsed time while running', async () => {
    await setup(draft({ run: { status: 'running', startedAt: new Date(NOW.getTime() - 42_000).toISOString(), baseTextAt: null } }));
    const run = host.querySelector<HTMLButtonElement>('.dly__summary');
    expect(run?.disabled).toBe(true);
    expect(run?.textContent?.trim()).toBe('Собираю… 0:42');
  });

  it('the summary button waits for a running update', async () => {
    await setup(draft());
    const loading = TestBed.inject(UpdateStore).load();
    http.expectOne({ method: 'GET', url: '/api/update' }).flush({ check: 'available', version: 'aaa111', run: { phase: 'running', startedAt: NOW.toISOString(), pid: 7 } });
    await loading;
    await fixture.whenStable();

    const summary = button('✦ Собрать из сессий');
    expect(summary.disabled).toBe(true);
    expect(summary.title).toBe('Идёт обновление Worklog');
  });

  it('failed run shows the error', async () => {
    await setup(draft({ run: { status: 'failed', at: at(5, 11), error: 'claude завершился с кодом 1: Не авторизован' } }));
    expect(texts('.dly__error')).toEqual(['Не удалось собрать из сессий: claude завершился с кодом 1: Не авторизован']);
    expect(host.querySelector<HTMLButtonElement>('.dly__summary')?.disabled).toBe(false);
  });

  it('a group title opens the direction tab', async () => {
    await setup(draft());
    host.querySelector<HTMLButtonElement>('.dly__group-title')?.click();
    expect(TestBed.inject(TabsStore).layout().active).toBe('direction:seo');
  });

  it('an empty period says so', async () => {
    await setup(null, new Date(2026, 10, 9, 11, 0));
    expect(texts('.dly__empty')).toEqual(['За период ничего не записано']);
    expect(texts('.dly__hint')[0]).toContain('«✦ Собрать из сессий»');
  });

  it('marks ✦ items and candidates with AI words', async () => {
    const summary: SessionSummary = {
      ...SUMMARY,
      items: [{ id: 'i1', sessionId: 's1', at: at(5, 9), directionId: 'seo', text: 'Разобрал с агентом причину' }],
      candidates: [{ id: 'c1', sessionId: 's1', text: 'Спросить Claude про стор', requestedBy: null, directionId: null }],
    };
    await setup(draft({ summary }));
    const line = host.querySelector('.dly__line_summary');
    expect(line?.classList.contains('dly__line_ai')).toBe(true);
    expect(line?.getAttribute('title')).toBe('Есть слова про ИИ: «агентом» — уйдёт в ленту направления');
    expect(host.querySelector('.dly__line_ai:not(.dly__line_summary)')).toBeNull();
    expect(host.querySelector('.dly__candidate')?.classList.contains('dly__candidate_ai')).toBe(true);
  });

  it('after the daily is held the title shows the next working day', async () => {
    await setup(null, new Date(2026, 10, 5, 15, 0));
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush({ ...state(null), dailies: [{ id: 'd', heldAt: at(5, 11, 40), periodStart: PERIOD, text: 'x', items: [] }] });
    await loading;
    await fixture.whenStable();
    expect(texts('.dly__title')).toEqual(['Дейлик пт, 6 ноября']);
  });

  it('an item bound to a done direction shows it in the select', async () => {
    const summary: SessionSummary = { ...SUMMARY, items: [{ id: 'i1', sessionId: 's1', at: at(5, 9), directionId: 'old', text: 'Доделал карту' }], candidates: [] };
    await setup(draft({ summary }));
    const loading = TestBed.inject(WorklogStore).refresh();
    const base = state(draft({ summary }));
    http.expectOne({ method: 'GET', url: '/api/state' }).flush({ ...base, directions: [...base.directions, direction('old', 'Карта', { status: 'done' })] });
    await loading;
    await fixture.whenStable();
    const select = host.querySelector<HTMLSelectElement>('.dly__group .dly__bind');
    expect(select?.value).toBe('old');
  });

  it('the example is not offered to move an item to', async () => {
    await setup(draft());
    const loading = TestBed.inject(WorklogStore).refresh();
    const base = state(draft());
    http.expectOne({ method: 'GET', url: '/api/state' }).flush({ ...base, directions: [...base.directions, direction('ex', 'Пример: карта пунктов выдачи', { example: true })] });
    await loading;
    await fixture.whenStable();
    const options = Array.from(host.querySelectorAll<HTMLOptionElement>('.dly__group .dly__bind option')).map(option => option.value);
    expect(options).toContain('red');
    expect(options).not.toContain('ex');
  });
});
