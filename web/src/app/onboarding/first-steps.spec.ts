import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import type { Direction, WorkEvent, WorklogState } from '@worklog/model';
import { TEST_PROFILE } from '@worklog/test-profile';
import { ProfileStore } from '../core/profile-store';
import { WorklogStore } from '../core/worklog-store';
import { FirstSteps } from './first-steps';
import { Tour } from './tour';

const AT = '2026-11-01T09:00:00.000Z';

function direction(id: string, fields: Partial<Direction> = {}): Direction {
  return { id, title: `Направление ${id}`, status: 'in_progress', tickets: [], links: [], events: [], order: 0, createdAt: AT, updatedAt: AT, ...fields };
}

function event(id: string): WorkEvent {
  return { id, at: AT, text: 'Разобрал BRD', source: 'manual', kind: 'note' };
}

function worklog(fields: Partial<WorklogState>): WorklogState {
  return { directions: [], todos: [], repeats: [], linkGroups: [], dailies: [], draft: null, notes: [], runs: [], ...fields };
}

const EXAMPLE = direction('ex', { title: 'Пример: капча на входе', example: true, events: [event('e0')] });
const TODO = { id: 't', text: 'Дело', done: false, createdAt: AT };
const ALL_DONE = worklog({ directions: [direction('own', { events: [event('e1')] })], todos: [TODO], onboarding: { tabsReadAt: AT } });

describe('FirstSteps', () => {
  let fixture: ComponentFixture<FirstSteps>;
  let http: HttpTestingController;
  let host: HTMLElement;

  async function setup(state: WorklogState): Promise<void> {
    localStorage.clear();
    TestBed.configureTestingModule({ imports: [FirstSteps], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    const profiles = TestBed.inject(ProfileStore);
    const loadingProfile = profiles.load();
    http.expectOne({ method: 'GET', url: '/api/profile' }).flush({ profile: TEST_PROFILE });
    await loadingProfile;
    await load(state);
    fixture = TestBed.createComponent(FirstSteps);
    host = fixture.nativeElement;
    document.body.append(host);
    await fixture.whenStable();
  }

  async function load(state: WorklogState): Promise<void> {
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(state);
    await loading;
  }

  async function reload(state: WorklogState): Promise<void> {
    await load(state);
    await fixture.whenStable();
  }

  afterEach(() => {
    host?.remove();
    localStorage.clear();
    try {
      http.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  function texts(selector: string): string[] {
    return Array.from(host.querySelectorAll(selector)).map(node => node.textContent?.replace(/\s+/g, ' ').trim() ?? '');
  }

  function showButtons(): HTMLButtonElement[] {
    return Array.from(host.querySelectorAll<HTMLButtonElement>('.fs__show'));
  }

  function pill(): HTMLButtonElement {
    const found = host.querySelector('.fs__pill');
    if (!(found instanceof HTMLButtonElement)) throw new Error('no .fs__pill');
    return found;
  }

  async function unfold(): Promise<void> {
    pill().click();
    await fixture.whenStable();
  }

  /** the PATCH and the refresh after it */
  async function answerPatch(body: unknown, state: WorklogState): Promise<void> {
    const request = http.expectOne({ method: 'PATCH', url: '/api/onboarding' });
    expect(request.request.body).toEqual(body);
    request.flush(state.onboarding ?? {});
    await new Promise(resolve => setTimeout(resolve));
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(state);
    await new Promise(resolve => setTimeout(resolve));
    await fixture.whenStable();
  }

  it('shows Первые шаги 1/4 in the corner and unfolds the card with four steps', async () => {
    await setup(worklog({ directions: [EXAMPLE, direction('own', { title: 'Тёмная тема', order: 1 })] }));
    expect(texts('.fs__pill')).toEqual(['Первые шаги 1/4']);
    expect(pill().getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.fs__card')).toBeNull();

    await unfold();
    expect(pill().getAttribute('aria-expanded')).toBe('true');
    expect(texts('.fs__title')).toEqual(['Первые шаги · 1 из 4']);
    expect(texts('.fs__label')).toEqual(['Заведите своё направление', 'Разложите вкладки Chrome по направлениям', 'Запишите, что произошло', 'Добавьте дело']);
    expect(texts('.fs__label_done')).toEqual(['Заведите своё направление']);
    const items = Array.from(host.querySelectorAll('.fs__item'));
    expect(items.map(item => item.querySelectorAll('wl-prompt').length)).toEqual([0, 1, 1, 2]);
    expect(texts('.pr__text')).toEqual([
      'разбери вкладки chrome в worklog',
      'запиши в worklog по направлению «Тёмная тема»: бэк поправил редирект, жду стенд',
      'добавь в worklog дело: завести задачу на бэк, просил аналитик',
      'добавь в worklog повторяющееся дело: дейлик каждый будний день в 11:30',
    ]);
  });

  it('takes prompts from the profile', async () => {
    await setup(worklog({ directions: [EXAMPLE] }));
    await unfold();

    expect(texts('.pr__text')[0]).toContain('APP-1234');
  });

  it('is gone when hidden', async () => {
    await setup(worklog({ directions: [EXAMPLE] }));
    expect(host.querySelector('.fs__pill')).not.toBeNull();

    await reload(worklog({ directions: [EXAMPLE], onboarding: { stepsHidden: true } }));
    expect(host.querySelector('.fs__pill')).toBeNull();
  });

  it('is gone once every step is done and sends stepsDone: true once', async () => {
    await setup(worklog({ directions: [EXAMPLE] }));
    await unfold();
    await reload(ALL_DONE);
    expect(host.querySelector('.fs__pill')).toBeNull();
    expect(host.querySelector('.fs__card')).toBeNull();

    await answerPatch({ stepsDone: true }, ALL_DONE);
    await reload(worklog({ ...ALL_DONE, todos: [TODO, { ...TODO, id: 't2' }] }));
    http.expectNone({ method: 'PATCH', url: '/api/onboarding' });
  });

  it('stays gone after stepsDoneAt even when a step is undone again', async () => {
    await setup(worklog({ directions: [EXAMPLE], onboarding: { stepsDoneAt: AT } }));
    expect(host.querySelector('.fs__pill')).toBeNull();
    http.expectNone({ method: 'PATCH', url: '/api/onboarding' });
  });

  it('Скрыть sends stepsHidden: true', async () => {
    await setup(worklog({ directions: [EXAMPLE] }));
    await unfold();

    host.querySelector<HTMLButtonElement>('.fs__hide')?.click();

    await answerPatch({ stepsHidden: true }, worklog({ directions: [EXAMPLE], onboarding: { stepsHidden: true } }));
    expect(host.querySelector('.fs__pill')).toBeNull();
  });

  it('Показать folds the card before the tour bubble', async () => {
    await setup(worklog({ directions: [EXAMPLE] }));
    const tour = TestBed.inject(Tour);
    const show = vi.spyOn(tour, 'show').mockImplementation(() => undefined);

    for (let i = 0; i < 4; i++) {
      await unfold();
      showButtons()[i].click();
      await fixture.whenStable();
      expect(host.querySelector('.fs__card')).toBeNull();
    }

    expect(show.mock.calls).toEqual([['add'], ['chrome-tabs'], ['events'], ['todos']]);
  });

  it('folds on Escape, on a click outside and on the button again', async () => {
    await setup(worklog({ directions: [EXAMPLE] }));
    expect(host.querySelector('.fs__card')).toBeNull();

    await unfold();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await fixture.whenStable();
    expect(host.querySelector('.fs__card')).toBeNull();

    await unfold();
    host.querySelector('.fs__intro')?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await fixture.whenStable();
    expect(host.querySelector('.fs__card')).not.toBeNull();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await fixture.whenStable();
    expect(host.querySelector('.fs__card')).toBeNull();

    await unfold();
    await unfold();
    expect(host.querySelector('.fs__card')).toBeNull();
  });
});
