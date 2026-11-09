import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import type { Direction, WorklogState } from '@worklog/model';
import { ticketFromKey } from '@worklog/model';
import { TabsStore } from '../core/tabs-store';
import { ProfileStore } from '../core/profile-store';
import { WorklogStore } from '../core/worklog-store';
import { DoneView } from './done-view';
import { TEST_PROFILE } from '@worklog/test-profile';

const on = (year: number, month: number, day: number): string => new Date(year, month, day, 12).toISOString();

function direction(id: string, title: string, fields: Partial<Direction> = {}): Direction {
  return { id, title, status: 'done', tickets: [], links: [], events: [], order: 0, createdAt: on(2025, 0, 1), updatedAt: on(2025, 0, 1), ...fields };
}

const tickets = (...keys: string[]) => keys.map(key => ticketFromKey(key, TEST_PROFILE));
const PROMO_TICKETS = Array.from({ length: 20 }, (_, i) => `APP-${7000 + i}`);

function state(directions: Direction[]): WorklogState {
  return { directions, todos: [], repeats: [], linkGroups: [], dailies: [], draft: null, notes: [], runs: [] };
}

const DIRECTIONS: Direction[] = [
  direction('traffic', 'Источник трафика', { doneAt: on(2026, 9, 30), tickets: tickets('APP-9352', 'WEB-5581') }),
  direction('twofa', 'Развитие 2FA', { doneAt: on(2026, 9, 22), tickets: tickets('APP-7098', 'WEB-4332', 'APP-9438') }),
  direction('promo', 'Промокоды', { doneAt: on(2026, 3, 9), tickets: tickets(...PROMO_TICKETS) }),
  direction('reg', 'Экран успешной регистрации', { doneAt: on(2025, 11, 26), tickets: tickets('APP-6339', 'WEB-3683') }),
  direction('stores', 'Браузерные сторы', { status: 'in_progress', tickets: tickets('APP-9618') }),
];

describe('DoneView', () => {
  let fixture: ComponentFixture<DoneView>;
  let http: HttpTestingController;
  let host: HTMLElement;

  async function load(directions: Direction[]): Promise<void> {
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(state(directions));
    await loading;
    await fixture.whenStable();
  }

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({ imports: [DoneView], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    const profile = TestBed.inject(ProfileStore).load();
    http.expectOne({ method: 'GET', url: '/api/profile' }).flush({ profile: TEST_PROFILE });
    await profile;
    fixture = TestBed.createComponent(DoneView);
    host = fixture.nativeElement;
    await load(DIRECTIONS);
  });

  afterEach(() => {
    http.verify();
    TestBed.resetTestingModule();
  });

  function texts(selector: string, root: ParentNode = host): string[] {
    return Array.from(root.querySelectorAll(selector)).map(node => node.textContent?.replace(/\s+/g, ' ').trim() ?? '');
  }

  function buttons(selector: string): HTMLButtonElement[] {
    return Array.from(host.querySelectorAll<HTMLButtonElement>(selector));
  }

  async function search(value: string): Promise<void> {
    const input = host.querySelector<HTMLInputElement>('.dv__search');
    if (!input) throw new Error('нет поиска');
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
  }

  async function chooseYear(year: string): Promise<void> {
    const button = buttons('.dv__year').find(b => b.textContent?.trim() === year);
    if (!button) throw new Error(`нет года ${year}`);
    button.click();
    await fixture.whenStable();
  }

  it('shows the latest year with summary and months', () => {
    expect(texts('.dv__title')).toEqual(['Сделано']);
    expect(texts('.dv__year')).toEqual(['2026', '2025']);
    expect(texts('.dv__year_active')).toEqual(['2026']);
    expect(texts('.dv__summary')).toEqual(['3 направления · 25 задач за 2026']);
    expect(texts('.dv__month-title')).toEqual(['Октябрь', 'Апрель']);
    expect(texts('.dv__month-meta')[0]).toBe('2 направления · 5 задач');

    const [first] = Array.from(host.querySelectorAll('.dv__row'));
    expect(texts('.dv__row-title', first)).toEqual(['Источник трафика']);
    expect(texts('.dv__chip', first)).toEqual(['App · Web']);
    expect(first.querySelector('.dv__count')).toBeNull();
    expect(texts('.dv__date', first)).toEqual(['30 окт']);

    const promo = Array.from(host.querySelectorAll('.dv__row')).find(row => row.textContent?.includes('Промокоды'));
    if (!promo) throw new Error('нет строки промокодов');
    expect(texts('.dv__chip', promo)).toEqual(['App']);
    expect(texts('.dv__count', promo)).toEqual(['20 задач']);
  });

  it('year switch shows 2025', async () => {
    await chooseYear('2025');
    expect(texts('.dv__month-title')).toEqual(['Декабрь']);
    expect(texts('.dv__summary')).toEqual(['1 направление · 2 задачи за 2025']);
  });

  it('bars: 12, empty months disabled, click scrolls to the month', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const bars = buttons('.dv__bar');
    expect(bars).toHaveLength(12);
    expect(bars[0].disabled).toBe(true);
    expect(bars[9].disabled).toBe(false);
    bars[9].click();
    await fixture.whenStable();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(host.querySelector('[data-month="2026-10"]'));
  });

  it('search spans years and hides the chart', async () => {
    await search('регистрац');
    expect(host.querySelector('.dv__bar')).toBeNull();
    expect(host.querySelector('.dv__year')).toBeNull();
    expect(texts('.dv__month-title')).toEqual(['Декабрь 2025']);
    await search('нет такого');
    expect(texts('.dv__empty')).toEqual(['Ничего не найдено']);
  });

  it('row opens the direction tab', async () => {
    buttons('.dv__row')[0].click();
    await fixture.whenStable();
    expect(TestBed.inject(TabsStore).layout().active).toBe('direction:traffic');
  });

  it('falls back to the latest year when the chosen one empties', async () => {
    await chooseYear('2025');
    await load(DIRECTIONS.map(d => (d.id === 'reg' ? { ...d, status: 'in_progress' } : d)));
    expect(host.querySelector('.dv__year')).toBeNull();
    expect(texts('.dv__summary')).toEqual(['3 направления · 25 задач за 2026']);
  });

  it('empty state', async () => {
    await load([DIRECTIONS[4]]);
    expect(texts('.dv__empty')).toEqual(['Пока ничего не сделано']);
    expect(host.querySelector('.dv__summary')).toBeNull();
  });
});
