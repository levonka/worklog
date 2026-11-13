import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { Direction, Status, WorklogState } from '@worklog/model';
import { TabsStore } from '../core/tabs-store';
import { WorklogStore } from '../core/worklog-store';
import { Tour } from './tour';
import { DIRECTION_STEPS, TOUR_STEP_IDS, TOUR_STEPS } from './tour-steps';
import type { TourStepId } from './tour-steps';

const CREATED_AT = '2026-11-01T09:00:00.000Z';
const STATE_REQUEST = { method: 'GET', url: '/api/state' };
const ONBOARDING_REQUEST = { method: 'PATCH', url: '/api/onboarding' };

function direction(id: string, status: Status, order: number, fields: Partial<Direction> = {}): Direction {
  return { id, title: `Направление ${id}`, status, tickets: [], links: [], events: [], order, createdAt: CREATED_AT, updatedAt: CREATED_AT, ...fields };
}

function worklog(fields: Partial<WorklogState>): WorklogState {
  return { directions: [], todos: [], repeats: [], linkGroups: [], dailies: [], draft: null, notes: [], runs: [], ...fields };
}

const EXAMPLE = direction('ex', 'in_progress', 5, { title: 'Пример: карта пунктов выдачи', example: true });

function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve));
}

describe('Tour', () => {
  let http: HttpTestingController;
  let tour: Tour;
  let tabs: TabsStore;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    tour = TestBed.inject(Tour);
    tabs = TestBed.inject(TabsStore);
  });

  afterEach(() => {
    localStorage.clear();
    try {
      http.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  async function load(state: WorklogState): Promise<void> {
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne(STATE_REQUEST).flush(state);
    await loading;
    TestBed.tick();
  }

  /** the PATCH of tourClosed and the refresh after it */
  async function answerClosed(state: WorklogState): Promise<unknown> {
    const request = http.expectOne(ONBOARDING_REQUEST);
    const body = request.request.body;
    request.flush({ tourClosedAt: CREATED_AT });
    await settle();
    http.expectOne(STATE_REQUEST).flush({ ...state, onboarding: { tourClosedAt: CREATED_AT } });
    await settle();
    return body;
  }

  function stepIds(): TourStepId[] {
    const ids: TourStepId[] = [];
    for (let view = tour.current(); view !== null && ids.length <= TOUR_STEP_IDS.length; view = tour.current()) {
      ids.push(view.step.id);
      if (view.index + 1 === view.total) break;
      tour.next();
    }
    return ids;
  }

  function goTo(id: TourStepId): void {
    for (let view = tour.current(); view !== null && view.step.id !== id; view = tour.current()) tour.next();
  }

  it('picks the example for direction steps, otherwise the first own active direction, otherwise drops them', async () => {
    await load(worklog({ directions: [direction('own', 'testing', 0), EXAMPLE] }));
    tour.start();
    expect(tour.directionId()).toBe('ex');
    expect(tour.current()?.total).toBe(TOUR_STEP_IDS.length);
    tour.close();
    await answerClosed(worklog({}));

    await load(worklog({ directions: [direction('parked', 'parked', 0), direction('done', 'done', 1), direction('own', 'testing', 2)] }));
    tour.start();
    expect(tour.directionId()).toBe('own');
    tour.close();
    await answerClosed(worklog({}));

    await load(worklog({ directions: [direction('parked', 'parked', 0)] }));
    tour.start();
    expect(tour.directionId()).toBeNull();
    const run = stepIds();
    expect(run).toEqual(TOUR_STEP_IDS.filter(id => !DIRECTION_STEPS.includes(id)));
    for (const id of ['card', 'drag', 'direction', 'events', 'agent', 'menu']) expect(run).not.toContain(id);
    tour.close();
    await answerClosed(worklog({}));
  });

  it('shows the tabs step right after the add step, also without directions', async () => {
    for (const directions of [[EXAMPLE], []]) {
      await load(worklog({ directions }));
      tour.start();
      const run = stepIds();
      expect(run[run.indexOf('add') + 1]).toBe('chrome-tabs');
      tour.close();
      await answerClosed(worklog({}));
    }
  });

  it('opens the screen of a step and comes back to the saved layout on close', async () => {
    const state = worklog({ directions: [EXAMPLE] });
    await load(state);
    tabs.replaceLayout({ tabs: ['board'], active: 'board', split: null, ratio: 0.5 });
    const before = tabs.layout();

    tour.start();
    goTo('todos');
    expect(tabs.layout().active).toBe('todos');
    goTo('drag');
    expect(tabs.layout()).toMatchObject({ active: 'board', split: 'todos' });
    goTo('events');
    expect(tabs.layout().tabs).toContain('direction:ex');
    expect([tabs.layout().active, tabs.layout().split]).toContain('direction:ex');
    goTo('daily');
    expect(tabs.layout().active).toBe('daily');

    tour.close();
    expect(tour.current()).toBeNull();
    expect(tabs.layout()).toEqual(before);
    expect(await answerClosed(state)).toEqual({ tourClosed: true });
  });

  it('forgets the direction deleted mid-tour: its tab closes and the next direction step does not open it again', async () => {
    await load(worklog({ directions: [EXAMPLE] }));
    tour.start();
    goTo('events');
    expect(tabs.layout().tabs).toContain('direction:ex');

    await load(worklog({}));

    expect(tabs.layout().tabs).not.toContain('direction:ex');
    expect(tour.directionId()).toBeNull();
    tour.next();
    expect(tour.current()?.step.id).toBe('agent');
    expect(tabs.layout().tabs).not.toContain('direction:ex');
    tour.close();
    await answerClosed(worklog({}));
  });

  it('shows the board where it is open for the drag step, also in the right pane behind other tabs', async () => {
    const state = worklog({ directions: [EXAMPLE] });
    await load(state);
    tabs.replaceLayout({ tabs: ['daily', 'board'], active: 'daily', split: 'board', ratio: 0.5 });

    tour.start();
    goTo('drag');

    expect(tabs.layout()).toMatchObject({ active: 'todos', split: 'board' });
    tour.close();
    await answerClosed(state);
  });

  it('keeps the saved layout from before the tour while it runs, so a reload mid-tour does not take the tour layout', async () => {
    const state = worklog({ directions: [EXAMPLE] });
    await load(state);
    tabs.replaceLayout({ tabs: ['board'], active: 'board', split: null, ratio: 0.5 });
    const stored = localStorage.getItem('worklog.layout.v1');

    tour.start();
    goTo('events');

    expect(localStorage.getItem('worklog.layout.v1')).toBe(stored);
    tour.close();
    expect(localStorage.getItem('worklog.layout.v1')).toBe(stored);
    await answerClosed(state);
  });

  it('the menu step promises ⌘Z only right after the deletion', () => {
    expect(TOUR_STEPS.find(step => step.id === 'menu')?.text).toContain('сразу после удаления ⌘Z');
  });

  it('close records tourClosed and autoStart does nothing afterwards', async () => {
    await load(worklog({ onboarding: { tourClosedAt: CREATED_AT } }));

    tour.autoStart();

    expect(tour.current()).toBeNull();
  });

  it('autoStart starts once when onboarding has no tourClosedAt', async () => {
    tour.autoStart();
    expect(tour.current()).toBeNull();

    const state = worklog({ directions: [EXAMPLE] });
    await load(state);
    tour.autoStart();
    expect(tour.current()?.step.id).toBe('welcome');

    tour.close();
    await answerClosed(state);
    tour.autoStart();
    expect(tour.current()).toBeNull();
  });

  it('show opens one step with single: true and close does not record tourClosed nor restore the layout', async () => {
    await load(worklog({ directions: [EXAMPLE, direction('own', 'waiting', 0)] }));

    tour.show('events');

    expect(tour.current()).toMatchObject({ step: { id: 'events' }, index: 0, total: 1, single: true });
    expect(tour.directionId()).toBe('own');
    const shown = tabs.layout();
    expect(shown.tabs).toContain('direction:own');

    tour.next();

    expect(tour.current()).toBeNull();
    expect(tabs.layout()).toEqual(shown);
    http.expectNone(ONBOARDING_REQUEST);
  });

  it('show of the tabs step brings back the hidden sidebar, where its button is', async () => {
    await load(worklog({ directions: [EXAMPLE] }));
    tabs.toggleSidebar();
    expect(tabs.sidebarHidden()).toBe(true);

    tour.show('chrome-tabs');

    expect(tabs.sidebarHidden()).toBe(false);
    expect(tour.current()?.step.id).toBe('chrome-tabs');
  });

  it('next past the last step closes the tour', async () => {
    const state = worklog({});
    await load(state);
    tour.start();

    for (let i = 0; i < TOUR_STEP_IDS.length && tour.current() !== null; i++) tour.next();

    expect(tour.current()).toBeNull();
    expect(await answerClosed(state)).toEqual({ tourClosed: true });
  });

  it('skip goes on in the direction of the last move; back stops at the first step', async () => {
    const state = worklog({ directions: [EXAMPLE] });
    await load(state);
    tour.start();
    tour.back();
    expect(tour.current()?.index).toBe(0);

    tour.next();
    tour.next();
    tour.skip();
    expect(tour.current()?.index).toBe(3);
    tour.back();
    tour.skip();
    expect(tour.current()?.index).toBe(1);

    tour.close();
    await answerClosed(state);
  });
});
