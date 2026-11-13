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

  it('lists three steps with done ones struck through and without a prompt', async () => {
    await setup(worklog({ directions: [EXAMPLE, direction('own', { title: 'Тёмная тема', order: 1 })] }));

    expect(texts('.fs__title')).toEqual(['Первые шаги · 1 из 3']);
    expect(texts('.fs__label')).toEqual(['Заведите своё направление', 'Запишите, что произошло', 'Добавьте дело']);
    expect(texts('.fs__label_done')).toEqual(['Заведите своё направление']);
    const items = Array.from(host.querySelectorAll('.fs__item'));
    expect(items[0].querySelector('wl-prompt')).toBeNull();
    expect(items[1].querySelectorAll('wl-prompt')).toHaveLength(1);
    expect(items[2].querySelectorAll('wl-prompt')).toHaveLength(2);
    expect(texts('.pr__text')).toEqual(['запиши в worklog по направлению «Тёмная тема»: бэк поправил редирект, жду стенд', 'добавь в worklog дело: завести задачу на бэк, просил аналитик', 'добавь в worklog повторяющееся дело: дейлик каждый будний день в 11:30']);
  });

  it('takes prompts from the profile', async () => {
    await setup(worklog({ directions: [EXAMPLE] }));

    expect(texts('.pr__text')[0]).toContain('APP-1234');
  });

  it('is gone when every step is done or when hidden', async () => {
    await setup(worklog({ directions: [EXAMPLE] }));
    expect(host.querySelector('.fs__card')).not.toBeNull();

    await reload(worklog({ directions: [EXAMPLE], onboarding: { stepsHidden: true } }));
    expect(host.querySelector('.fs__card')).toBeNull();

    await reload(worklog({ directions: [direction('own', { events: [event('e1')] })], todos: [{ id: 't', text: 'Дело', done: false, createdAt: AT }] }));
    expect(host.querySelector('.fs__card')).toBeNull();
  });

  it('Скрыть sends stepsHidden: true', async () => {
    await setup(worklog({ directions: [EXAMPLE] }));

    host.querySelector<HTMLButtonElement>('.fs__hide')?.click();

    const request = http.expectOne({ method: 'PATCH', url: '/api/onboarding' });
    expect(request.request.body).toEqual({ stepsHidden: true });
    request.flush({ stepsHidden: true });
    await new Promise(resolve => setTimeout(resolve));
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(worklog({ directions: [EXAMPLE], onboarding: { stepsHidden: true } }));
    await new Promise(resolve => setTimeout(resolve));
    await fixture.whenStable();
    expect(host.querySelector('.fs__card')).toBeNull();
  });

  it('Показать asks the tour for the step of the item', async () => {
    await setup(worklog({ directions: [EXAMPLE] }));
    const tour = TestBed.inject(Tour);
    const show = vi.spyOn(tour, 'show').mockImplementation(() => undefined);

    for (const button of showButtons()) button.click();

    expect(show.mock.calls).toEqual([['add'], ['events'], ['todos']]);
  });
});
