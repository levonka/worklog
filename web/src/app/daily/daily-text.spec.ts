import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import type { DailyDraft, WorklogState } from '@worklog/model';
import { TabsStore } from '../core/tabs-store';
import { WorklogStore } from '../core/worklog-store';
import { DailyText } from './daily-text';

// Thursday 5 November 2026 at 11:05; the period starts on Wednesday at 11:30
const NOW = new Date(2026, 10, 5, 11, 5);
const PERIOD = new Date(2026, 10, 4, 11, 30).toISOString();
const at = (hour: number, minute = 0): string => new Date(2026, 10, 5, hour, minute).toISOString();
const TEMPLATE = 'Касаемо задачи «Сторы»: Разобрал localStorage.';

function state(draft: DailyDraft | null, extraEvent = false): WorklogState {
  const events = [{ id: 'e1', at: at(9), text: 'Разобрал localStorage', source: 'manual' as const, kind: 'note' as const }];
  if (extraEvent) events.push({ id: 'e2', at: at(10, 30), text: 'Завёл задачу', source: 'manual', kind: 'note' });
  return {
    directions: [{ id: 'a', title: 'Сторы', status: 'waiting', tickets: [], links: [], events, order: 0, createdAt: at(8), updatedAt: at(8) }],
    todos: [],
    repeats: [],
    linkGroups: [],
    dailies: [],
    draft,
    notes: [],
    runs: [],
  };
}

function draft(fields: Partial<DailyDraft>): DailyDraft {
  return { periodStart: PERIOD, text: null, textAt: null, summary: null, run: null, ...fields };
}

describe('DailyText', () => {
  let fixture: ComponentFixture<DailyText>;
  let http: HttpTestingController;
  let host: HTMLElement;
  let store: WorklogStore;

  async function setup(initial: WorklogState): Promise<void> {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW);
    localStorage.clear();
    TestBed.configureTestingModule({ imports: [DailyText], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    store = TestBed.inject(WorklogStore);
    await load(initial);
    fixture = TestBed.createComponent(DailyText);
    host = fixture.nativeElement;
    await fixture.whenStable();
  }

  async function load(value: WorklogState): Promise<void> {
    const loading = store.refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(value);
    await loading;
  }

  afterEach(() => {
    vi.useRealTimers();
    try {
      http.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  function area(): HTMLTextAreaElement {
    const found = host.querySelector<HTMLTextAreaElement>('.dt__text');
    if (!found) throw new Error('нет поля текста');
    return found;
  }

  function type(value: string): void {
    area().value = value;
    area().dispatchEvent(new Event('input'));
  }

  function button(text: string): HTMLButtonElement {
    const found = Array.from(host.querySelectorAll('button')).find(node => node.textContent?.trim() === text);
    if (!found) throw new Error(`Нет кнопки «${text}»`);
    return found;
  }

  async function answerPut(expected: string | null, after: WorklogState): Promise<void> {
    const put = http.expectOne({ method: 'PUT', url: '/api/daily/text' });
    expect(put.request.body).toEqual({ periodStart: PERIOD, text: expected });
    put.flush({});
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(after);
    await vi.advanceTimersByTimeAsync(0);
    await fixture.whenStable();
  }

  it('shows the template with its badge', async () => {
    await setup(state(null));
    expect(area().value).toBe(TEMPLATE);
    expect(host.querySelector('.dt__badge')?.textContent?.trim()).toBe('шаблон');
  });

  it('typing saves after debounce and on blur', async () => {
    await setup(state(null));
    area().dispatchEvent(new Event('focus'));
    type('Своё');
    await vi.advanceTimersByTimeAsync(599);
    http.expectNone({ method: 'PUT', url: '/api/daily/text' });
    await vi.advanceTimersByTimeAsync(1);
    await answerPut('Своё', state(draft({ text: 'Своё', textAt: at(11, 5) })));

    type('Своё 2');
    area().dispatchEvent(new Event('blur'));
    await answerPut('Своё 2', state(draft({ text: 'Своё 2', textAt: at(11, 5) })));
    expect(area().value).toBe('Своё 2');
    expect(host.querySelector('.dt__badge')?.textContent?.trim()).toBe('правлено');
  });

  it('focus and blur without typing save nothing', async () => {
    await setup(state(null));
    area().dispatchEvent(new Event('focus'));
    area().dispatchEvent(new Event('blur'));
    await vi.advanceTimersByTimeAsync(1000);
    http.expectNone({ method: 'PUT', url: '/api/daily/text' });
  });

  it('clearing the field returns to template', async () => {
    await setup(state(draft({ text: 'Своё', textAt: at(10) })));
    area().dispatchEvent(new Event('focus'));
    type('   ');
    area().dispatchEvent(new Event('blur'));
    await answerPut(null, state(null));
    expect(area().value).toBe(TEMPLATE);
  });

  it('external update does not replace text while focused', async () => {
    await setup(state(null));
    area().dispatchEvent(new Event('focus'));
    type('Набираю');
    await load(state(draft({ text: 'С сервера', textAt: at(11) })));
    await fixture.whenStable();
    expect(area().value).toBe('Набираю');
    area().dispatchEvent(new Event('blur'));
    await answerPut('Набираю', state(draft({ text: 'Набираю', textAt: at(11, 5) })));
  });

  it('shows AI warning', async () => {
    await setup(state(draft({ text: 'Спросил у Claude, агент всё сделал', textAt: at(10) })));
    expect(host.querySelector('.dt__warning')?.textContent?.trim()).toBe('В тексте есть: «claude», «агент» — перед отправкой лучше убрать');
  });

  it('marks text from the summary', async () => {
    const summary = { ranAt: at(10), sessionCount: 1, items: [], candidates: [] };
    await setup(state(draft({ text: 'Из сессий', textAt: at(10), summary })));
    expect(host.querySelector('.dt__badge')?.textContent?.trim()).toBe('✦ из сессий');
  });

  it('new events hint offers both rebuilds', async () => {
    await setup(state(draft({ text: 'Своё', textAt: at(10) }), true));
    expect(host.querySelector('.dt__hint')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Появились новые события — пересобрать: шаблоном · ✦ из сессий');
    button('шаблоном').click();
    await answerPut(null, state(null, true));
    expect(host.querySelector('.dt__hint')).toBeNull();
  });

  it('copy writes to clipboard and shows Скопировано', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await setup(state(null));
    button('Скопировать текст').click();
    await vi.advanceTimersByTimeAsync(0);
    await fixture.whenStable();
    expect(writeText).toHaveBeenCalledWith(TEMPLATE);
    expect(button('Скопировано ✓')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(2000);
    await fixture.whenStable();
    expect(button('Скопировать текст')).toBeTruthy();
  });

  it('Дейлик прошёл needs a second click and calls holdDaily', async () => {
    await setup(state(null));
    button('Дейлик прошёл').click();
    await fixture.whenStable();
    http.expectNone({ method: 'POST', url: '/api/daily/held' });
    button('Точно? Нажмите ещё раз').click();
    const held = http.expectOne({ method: 'POST', url: '/api/daily/held' });
    expect(held.request.body).toEqual({ periodStart: PERIOD, text: TEMPLATE });
    held.flush({});
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(state(null));
    await vi.advanceTimersByTimeAsync(0);
    await fixture.whenStable();
    expect(host.querySelector('.dt__saved')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Сохранено в Историю Открыть');
    button('Открыть').click();
    expect(TestBed.inject(TabsStore).layout().active).toBe('history');
  });

  it('the confirmation expires after 4 s', async () => {
    await setup(state(null));
    button('Дейлик прошёл').click();
    await vi.advanceTimersByTimeAsync(4000);
    await fixture.whenStable();
    expect(button('Дейлик прошёл')).toBeTruthy();
  });

  it('text typed before the period changed is sent for the old period', async () => {
    await setup(state(null));
    area().dispatchEvent(new Event('focus'));
    await load({ ...state(null), dailies: [{ id: 'd', heldAt: at(11), periodStart: PERIOD, text: 'x', items: [] }] });
    type('Вчерашнее');
    area().dispatchEvent(new Event('blur'));
    await answerPut('Вчерашнее', state(null));
  });

  it('a refocus while two saves are in flight keeps the last keystrokes', async () => {
    await setup(state(null));
    area().dispatchEvent(new Event('focus'));
    type('раз');
    await vi.advanceTimersByTimeAsync(600);
    const first = http.expectOne({ method: 'PUT', url: '/api/daily/text' });
    type('раз два');
    area().dispatchEvent(new Event('blur'));
    const second = http.expectOne({ method: 'PUT', url: '/api/daily/text' });
    first.flush({});
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(state(draft({ text: 'раз', textAt: at(11, 5) })));
    await vi.advanceTimersByTimeAsync(0);
    await fixture.whenStable();
    area().dispatchEvent(new Event('focus'));
    await fixture.whenStable();
    expect(area().value).toBe('раз два');
    second.flush({});
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(state(draft({ text: 'раз два', textAt: at(11, 5) })));
    await vi.advanceTimersByTimeAsync(0);
  });

  it('the saved note goes away after 10 s', async () => {
    await setup(state(null));
    button('Дейлик прошёл').click();
    await fixture.whenStable();
    button('Точно? Нажмите ещё раз').click();
    http.expectOne({ method: 'POST', url: '/api/daily/held' }).flush({});
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(state(null));
    await vi.advanceTimersByTimeAsync(0);
    await fixture.whenStable();
    expect(host.querySelector('.dt__saved')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    await fixture.whenStable();
    expect(host.querySelector('.dt__saved')).toBeNull();
  });
});
