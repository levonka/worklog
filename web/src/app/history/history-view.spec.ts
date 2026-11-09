import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import type { Direction, WorkEvent, WorklogState } from '@worklog/model';
import { ticketFromKey } from '@worklog/model';
import { WorklogStore } from '../core/worklog-store';
import { HistoryView } from './history-view';
import { TEST_PROFILE } from '@worklog/test-profile';

const at = (day: number, hour: number): string => new Date(2026, 9, day, hour).toISOString();

function direction(id: string, title: string, fields: Partial<Direction> = {}): Direction {
  return { id, title, status: 'in_progress', tickets: [], links: [], events: [], order: 0, createdAt: at(1, 9), updatedAt: at(1, 9), ...fields };
}

// one event a day for 20 days of October
const EVENTS: WorkEvent[] = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, at: at(i + 1, 12), text: `Событие ${i + 1}`, source: 'manual', kind: 'note' }));

const STATE: WorklogState = {
  directions: [
    direction('seo', 'SEO-текст', { tickets: [ticketFromKey('APP-9355', TEST_PROFILE)], events: EVENTS }),
    direction('cap', 'Капча', { status: 'done', events: [{ id: 's', at: at(3, 15), text: 'Статус: Готово', source: 'system', kind: 'status' }] }),
  ],
  todos: [],
  repeats: [],
  linkGroups: [],
  dailies: [{ id: 'd', heldAt: at(20, 11), periodStart: at(19, 11), text: 'Касаемо задачи по сео', items: [] }],
  draft: null,
  notes: [],
  runs: [],
};

describe('HistoryView', () => {
  let fixture: ComponentFixture<HistoryView>;
  let http: HttpTestingController;
  let host: HTMLElement;

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({ imports: [HistoryView], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(STATE);
    await loading;
    fixture = TestBed.createComponent(HistoryView);
    host = fixture.nativeElement;
    await fixture.whenStable();
  });

  afterEach(() => {
    http.verify();
    TestBed.resetTestingModule();
  });

  function texts(selector: string): string[] {
    return Array.from(host.querySelectorAll(selector)).map(node => node.textContent?.replace(/\s+/g, ' ').trim() ?? '');
  }

  async function search(value: string): Promise<void> {
    const input = host.querySelector<HTMLInputElement>('.hv__search');
    if (!input) throw new Error('нет поиска');
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
  }

  it('shows 14 days then Показать ещё', async () => {
    expect(host.querySelectorAll('.hv__day')).toHaveLength(14);
    expect(texts('.hv__day-title')[0]).toBe('вт, 20 октября');
    host.querySelector<HTMLButtonElement>('.hv__more')?.click();
    await fixture.whenStable();
    expect(host.querySelectorAll('.hv__day')).toHaveLength(20);
    expect(host.querySelector('.hv__more')).toBeNull();
  });

  it('shows a daily card with its text', () => {
    expect(texts('.hv__daily-text')).toEqual(['Касаемо задачи по сео']);
  });

  it('search narrows the feed', async () => {
    await search('событие 7');
    expect(texts('.hv__entry-text')).toEqual(['Событие 7']);
    await search('нет такого');
    expect(texts('.hv__empty')).toEqual(['Ничего не найдено']);
  });

  it('history has no done block', () => {
    expect(host.querySelector('.hv__done-toggle')).toBeNull();
  });
});
