import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import type { Direction, WorklogState } from '@worklog/model';
import { TEST_PROFILE } from '@worklog/test-profile';
import { ProfileStore } from '../core/profile-store';
import { WorklogStore } from '../core/worklog-store';
import { Tour } from './tour';
import { TourOverlay } from './tour-overlay';
import { tourBubblePlace } from './tour-place';
import { TOUR_STEP_IDS } from './tour-steps';
import type { TourStepId } from './tour-steps';

const AT = '2026-11-01T09:00:00.000Z';

const EXAMPLE: Direction = {
  id: 'ex',
  title: 'Пример: капча на входе',
  status: 'in_progress',
  example: true,
  tickets: [],
  links: [],
  events: [],
  order: 0,
  createdAt: AT,
  updatedAt: AT,
};

const STATE: WorklogState = { directions: [EXAMPLE], todos: [], repeats: [], linkGroups: [], dailies: [], draft: null, notes: [], runs: [] };

describe('tourBubblePlace', () => {
  const view = { width: 1000, height: 700 };
  const bubble = { width: 300, height: 160 };

  it('stands below the target, pointing up at its middle', () => {
    expect(tourBubblePlace({ left: 400, top: 100, width: 100, height: 30 }, bubble, view)).toEqual({ left: 300, top: 142, arrow: 'up', arrowAt: 150 });
  });

  it('stands above a target near the bottom', () => {
    expect(tourBubblePlace({ left: 400, top: 600, width: 100, height: 30 }, bubble, view)).toEqual({ left: 300, top: 428, arrow: 'down', arrowAt: 150 });
  });

  it('stands right of a tall target, then left of one at the right edge', () => {
    expect(tourBubblePlace({ left: 100, top: 50, width: 200, height: 600 }, bubble, view)).toEqual({ left: 312, top: 270, arrow: 'left', arrowAt: 80 });
    expect(tourBubblePlace({ left: 700, top: 50, width: 200, height: 600 }, bubble, view)).toEqual({ left: 388, top: 270, arrow: 'right', arrowAt: 80 });
  });

  it('stands in the middle without a target or over a target as large as the window', () => {
    expect(tourBubblePlace(null, bubble, view)).toEqual({ left: 350, top: 270, arrow: null, arrowAt: 0 });
    expect(tourBubblePlace({ left: 0, top: 0, width: 1000, height: 700 }, bubble, view)).toEqual({ left: 350, top: 270, arrow: null, arrowAt: 0 });
  });

  it('stays inside the window and keeps the arrow on the target', () => {
    const place = tourBubblePlace({ left: 0, top: 10, width: 40, height: 20 }, bubble, view);
    expect(place).toEqual({ left: 8, top: 42, arrow: 'up', arrowAt: 18 });
  });
});

describe('TourOverlay', () => {
  let fixture: ComponentFixture<TourOverlay>;
  let http: HttpTestingController;
  let host: HTMLElement;
  let tour: Tour;
  let page: HTMLElement;

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({ imports: [TourOverlay], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    const profile = TestBed.inject(ProfileStore).load();
    http.expectOne({ method: 'GET', url: '/api/profile' }).flush({ profile: TEST_PROFILE });
    await profile;
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(STATE);
    await loading;
    tour = TestBed.inject(Tour);
    page = document.createElement('div');
    document.body.append(page);
    fixture = TestBed.createComponent(TourOverlay);
    host = fixture.nativeElement;
    await fixture.whenStable();
  });

  afterEach(() => {
    page.remove();
    localStorage.clear();
    try {
      http.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  /** marks every step's target on the page except the ones named; each has a box, as on screen */
  function targets(...missing: TourStepId[]): void {
    const marks = ['board-columns', 'board-add', 'sidebar-tabs', 'todo-input', 'tab-bar', 'daily-summary'];
    page.innerHTML =
      marks.map(mark => `<div data-tour="${mark}"></div>`).join('') +
      '<div data-direction-id="ex"></div>' +
      '<div data-direction-view="ex"><div data-tour="direction-links"></div><input data-tour="event-input" /><button data-tour="agent-button"></button><button data-tour="direction-menu"></button></div>';
    const of: Partial<Record<TourStepId, string>> = { board: 'board-columns', add: 'board-add', 'chrome-tabs': 'sidebar-tabs', todos: 'todo-input', tabs: 'tab-bar', daily: 'daily-summary' };
    for (const id of missing) page.querySelector(`[data-tour="${of[id] ?? id}"]`)?.remove();
    page.querySelectorAll<HTMLElement>('[data-tour], [data-direction-id]').forEach((element, index) => sized(element, new DOMRect(20, 20 + index * 40, 160, 32)));
  }

  function sized(element: Element | null, box: DOMRect): void {
    if (element === null) throw new Error('no element to size');
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(box);
  }

  function texts(selector: string): string[] {
    return Array.from(host.querySelectorAll(selector)).map(node => node.textContent?.replace(/\s+/g, ' ').trim() ?? '');
  }

  async function press(key: string): Promise<KeyboardEvent> {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    await fixture.whenStable();
    return event;
  }

  async function answerClosed(): Promise<void> {
    const request = http.expectOne({ method: 'PATCH', url: '/api/onboarding' });
    expect(request.request.body).toEqual({ tourClosed: true });
    request.flush({ tourClosedAt: AT });
    await new Promise(resolve => setTimeout(resolve));
    http.expectOne({ method: 'GET', url: '/api/state' }).flush({ ...STATE, onboarding: { tourClosedAt: AT } });
    await new Promise(resolve => setTimeout(resolve));
  }

  it('renders the step with its prompts and counts', async () => {
    targets();
    tour.start();
    tour.next();
    tour.next();
    await fixture.whenStable();

    expect(texts('.tu__title')).toEqual(['Новое направление']);
    expect(texts('.tu__count')).toEqual([`3 из ${TOUR_STEP_IDS.length}`]);
    expect(texts('.pr__text')).toEqual(['заведи в worklog направление по задачам APP-1234 и WEB-567']);
    expect(texts('.tu__foot button')).toEqual(['Пропустить экскурсию', 'Назад', 'Дальше']);
    expect(host.querySelector('.tu__ring')).not.toBeNull();
    expect(host.querySelector('.tu__bubble_placed')).not.toBeNull();
  });

  it('a single bubble has only Понятно', async () => {
    targets();
    tour.show('todos');
    await fixture.whenStable();

    expect(texts('.tu__foot button')).toEqual(['Понятно']);
    expect(texts('.pr__text')).toEqual(['добавь в worklog дело: завести задачу на бэк, просил аналитик', 'добавь в worklog повторяющееся дело: дейлик каждый будний день в 11:30']);
  });

  it('points the tabs step at the sidebar button and gives the tabs phrase', async () => {
    targets();
    const button = page.querySelector('[data-tour="sidebar-tabs"]');
    if (button === null) throw new Error('no sidebar-tabs mark');
    const measured = vi.spyOn(button, 'getBoundingClientRect');
    tour.show('chrome-tabs');
    await fixture.whenStable();

    expect(texts('.tu__title')).toEqual(['Ссылки из вкладок']);
    expect(texts('.pr__text')).toEqual(['разбери вкладки chrome в worklog']);
    expect(measured).toHaveBeenCalled();
    expect(host.querySelector('.tu__ring')).not.toBeNull();
  });

  it('skips a step whose target is not in the document', async () => {
    targets('board', 'add', 'chrome-tabs');
    tour.start();
    await fixture.whenStable();
    expect(texts('.tu__title')).toEqual(['Это Worklog']);

    tour.next();
    await fixture.whenStable();
    expect(tour.current()?.step.id).toBe('card');

    tour.back();
    await fixture.whenStable();
    expect(tour.current()?.step.id).toBe('welcome');

    page.innerHTML = '';
    tour.next();
    await fixture.whenStable();
    expect(tour.current()?.step.id).toBe('safety');
    expect(host.querySelector('.tu__ring')).toBeNull();
    expect(host.querySelector('.tu__dim')).not.toBeNull();
  });

  it('tells the board and direction steps without Jira, stands and builds when there is no profile', async () => {
    targets();
    const text = async (id: TourStepId): Promise<string> => {
      tour.show(id);
      await fixture.whenStable();
      const shown = texts('.tu__text')[0];
      tour.next();
      return shown;
    };
    expect(await text('board')).toMatch(/Jira/);
    expect(await text('direction')).toMatch(/стенды/);

    const reloading = TestBed.inject(ProfileStore).load();
    http.expectOne({ method: 'GET', url: '/api/profile' }).flush({ profile: null });
    await reloading;

    for (const id of ['board', 'direction', 'safety'] as const) expect(await text(id)).not.toMatch(/Jira|стенд|сборк|ветк/);
  });

  it('skips a target of zero size, as one not on screen', async () => {
    targets();
    sized(page.querySelector('[data-tour="board-columns"]'), new DOMRect(0, 0, 0, 0));
    tour.start();
    await fixture.whenStable();

    tour.next();
    await fixture.whenStable();

    expect(tour.current()?.step.id).toBe('add');
    tour.close();
    await answerClosed();
  });

  it('leaves the steps of a direction deleted mid-tour, even with another direction open beside', async () => {
    targets();
    tour.start();
    for (let view = tour.current(); view !== null && view.step.id !== 'events'; view = tour.current()) tour.next();
    await fixture.whenStable();
    expect(host.querySelector('.tu__bubble_placed')).not.toBeNull();

    page.querySelector('[data-direction-view="ex"]')?.remove();
    page.insertAdjacentHTML('beforeend', '<div data-direction-view="own"><input data-tour="event-input" /><button data-tour="agent-button"></button><button data-tour="direction-menu"></button></div>');
    page.querySelectorAll('[data-direction-view="own"] [data-tour]').forEach(element => sized(element, new DOMRect(300, 300, 160, 32)));
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush({ ...STATE, directions: [{ ...EXAMPLE, id: 'own', example: false }] });
    await loading;
    await fixture.whenStable();

    expect(tour.current()?.step.id).toBe('tabs');
    tour.close();
    await answerClosed();
  });

  it('Esc closes; Enter goes on; ← goes back; shortcuts of the window wait', async () => {
    targets();
    tour.start();
    await fixture.whenStable();

    await press('Enter');
    await press('ArrowRight');
    expect(tour.current()?.index).toBe(2);
    await press('ArrowLeft');
    expect(tour.current()?.index).toBe(1);

    const closeTab = new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', metaKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(closeTab);
    expect(closeTab.defaultPrevented).toBe(true);

    const escape = await press('Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(tour.current()).toBeNull();
    expect(host.querySelector('.tu__layer')).toBeNull();
    await answerClosed();

    const later = await press('Enter');
    expect(later.defaultPrevented).toBe(false);
  });
});
