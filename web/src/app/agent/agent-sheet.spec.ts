import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import type { AgentRun, Direction, Todo, WorklogState } from '@worklog/model';
import { ticketFromKey } from '@worklog/model';
import { AgentSheet } from '../core/agent-sheet';
import type { AgentLauncher } from '../core/api';
import type { AgentTarget } from '../core/agent-sheet';
import { ProfileStore } from '../core/profile-store';
import { WorklogStore } from '../core/worklog-store';
import { AgentSheetView } from './agent-sheet';
import { runSince } from './run-since';
import { TEST_PROFILE } from '@worklog/test-profile';

const AT = '2026-11-01T09:00:00.000Z';

function direction(fields: Partial<Direction>): Direction {
  return { id: 'd1', title: 'Браузерные сторы', status: 'in_progress', tickets: [], links: [], events: [], order: 0, createdAt: AT, updatedAt: AT, ...fields };
}

function todo(id: string, text: string, fields: Partial<Todo> = {}): Todo {
  return { id, text, done: false, createdAt: AT, ...fields };
}

const STATE: WorklogState = {
  directions: [
    direction({
      tickets: [ticketFromKey('CORE-580', TEST_PROFILE), ticketFromKey('APP-6120', TEST_PROFILE), ticketFromKey('WEB-3380', TEST_PROFILE)],
      links: [{ title: 'Теханализ', url: 'https://wiki.example.com/x', kind: 'confluence' }],
    }),
  ],
  todos: [todo('t1', 'Разобрать обёртки', { directionId: 'd1' }), todo('t2', 'Без направления')],
  repeats: [],
  linkGroups: [],
  dailies: [],
  draft: null,
  notes: [],
  runs: [],
};

describe('runSince', () => {
  it('gives the time for today and adds the date for an earlier day', () => {
    const run = (startedAt: Date): AgentRun => ({ id: 'r', template: 'execute', branch: 'dev', title: 'x', startedAt: startedAt.toISOString() });
    const today = new Date(2026, 10, 5);
    expect(runSince(run(new Date(2026, 10, 5, 14, 20)), today)).toBe('с 14:20');
    expect(runSince(run(new Date(2026, 10, 4, 9, 5)), today)).toBe('с 4 нояб 09:05');
  });
});

describe('AgentSheetView', () => {
  let fixture: ComponentFixture<AgentSheetView>;
  let http: HttpTestingController;
  let sheet: AgentSheet;
  let host: HTMLElement;

  function settle(ms = 0): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function open(target: AgentTarget, launcher: AgentLauncher = { terminal: 'warp', codeRoot: '~/Projects/app', agents: ['claude'], defaultAgent: 'claude' }): Promise<void> {
    sheet.open(target);
    fixture = TestBed.createComponent(AgentSheetView);
    fixture.componentRef.setInput('target', target);
    host = fixture.nativeElement;
    await fixture.whenStable();
    http.expectOne({ method: 'GET', url: '/api/agent/launcher' }).flush(launcher);
    await settle();
    await fixture.whenStable();
  }

  function text(element: Element | null): string {
    return (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  function button(label: string): HTMLButtonElement {
    const found = Array.from(host.querySelectorAll('button')).find(candidate => text(candidate) === label);
    if (!found) throw new Error(`button "${label}" not found`);
    return found;
  }

  function field<T extends Element>(selector: string, type: new () => T): T {
    const element = host.querySelector(selector);
    if (!(element instanceof type)) throw new Error(`${selector} not found`);
    return element;
  }

  function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    element.value = value;
    element.dispatchEvent(new Event('input'));
  }

  async function answerBranch(name: string, place: string): Promise<void> {
    await settle(300);
    http.expectOne(request => request.url === '/api/agent/branch' && request.params.get('name') === name).flush({ place });
    await settle();
    await fixture.whenStable();
  }

  beforeEach(async () => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    TestBed.configureTestingModule({ imports: [AgentSheetView], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    sheet = TestBed.inject(AgentSheet);
    const store = TestBed.inject(WorklogStore);
    const loading = store.refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(STATE);
    await loading;
  });

  async function useProfile(): Promise<void> {
    const loading = TestBed.inject(ProfileStore).load();
    http.expectOne({ method: 'GET', url: '/api/profile' }).flush({ profile: TEST_PROFILE });
    await loading;
  }

  afterEach(() => {
    try {
      http.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  it('the hint names the terminal and the folder', async () => {
    await open({ directionId: 'd1' }, { terminal: 'iterm', codeRoot: '~/Projects/app', agents: ['claude'], defaultAgent: 'claude' });
    expect(text(host.querySelector('.as__hint'))).toBe('Откроется новая вкладка iTerm2, ~/Projects/app');
  });

  it('does not launch an agent for the example', async () => {
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush({ ...STATE, directions: STATE.directions.map(item => ({ ...item, example: true as const })) });
    await loading;
    await open({ directionId: 'd1' });
    expect(text(host.querySelector('.as__hint'))).toBe('в примере агент не запускается');
    expect(button('Запустить ⌘↩').disabled).toBe(true);
  });

  it('does not offer sorting Chrome tabs among the templates', async () => {
    await open({ directionId: 'd1' });
    const labels = Array.from(host.querySelectorAll('.as__template'), item => text(item));
    expect(labels).toContain('Выполнить задачу');
    expect(labels).not.toContain('Разобрать вкладки Chrome');
  });

  it('without a profile the agent branch is main', async () => {
    await open({ directionId: 'd1' });
    expect(field('input[aria-label="Ветка"]', HTMLInputElement).value).toBe('main');
    expect(text(host.querySelector('.as__branch-hint'))).toBe('без ветки задачи');
  });

  it('shows the direction, its context and the task branch, then launches with the chosen parts', async () => {
    await useProfile();
    await open({ directionId: 'd1' });
    expect(text(host.querySelector('.as__title'))).toBe('✦ Поручение агенту · Браузерные сторы');
    expect(Array.from(host.querySelectorAll('.as__part'), part => [text(part.querySelector('.as__part-label')), text(part.querySelector('.as__part-summary'))])).toEqual([
      ['Тикеты', 'CORE-580, APP-6120 (App), WEB-3380 (Web) — агент откроет их сам'],
      ['Ссылки', 'Теханализ'],
      ['Дела', '«Разобрать обёртки»'],
    ]);
    const branch = field('input[aria-label="Ветка"]', HTMLInputElement);
    expect(branch.value).toBe('feature/APP-6120_WEB-3380');
    await answerBranch('feature/APP-6120_WEB-3380', 'none');
    expect(text(host.querySelector('.as__branch-hint'))).toBe('будет создана от dev');

    button('Декомпозировать').click();
    field<HTMLInputElement>('.as__part:nth-child(2) input', HTMLInputElement).click();
    type(field('textarea', HTMLTextAreaElement), 'по одному сервису');
    await fixture.whenStable();
    button('Запустить ⌘↩').click();

    const request = http.expectOne({ method: 'POST', url: '/api/agent/runs' });
    expect(request.request.body).toStrictEqual({
      template: 'decompose',
      directionId: 'd1',
      include: ['tickets', 'todos'],
      extra: 'по одному сервису',
      branch: 'feature/APP-6120_WEB-3380',
    });
    request.flush({});
    await settle();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(STATE);
    await settle();
    expect(sheet.target()).toBeNull();
  });

  it('agent sheet hides the agent switch with one agent', async () => {
    await useProfile();
    await open({ directionId: 'd1' });
    expect(host.querySelector('.as__agents')).toBeNull();
  });

  it('agent sheet offers both agents, starts with the remembered one and sends the choice', async () => {
    localStorage.setItem('worklog.agent', 'codex');
    try {
      await useProfile();
      await open({ directionId: 'd1' }, { terminal: 'warp', codeRoot: '~/Projects/app', agents: ['claude', 'codex'], defaultAgent: 'claude' });
      await answerBranch('feature/APP-6120_WEB-3380', 'local');
      expect(text(host.querySelector('.as__agent_on'))).toBe('Codex');
      button('Claude').click();
      await fixture.whenStable();
      expect(text(host.querySelector('.as__agent_on'))).toBe('Claude');
      button('Запустить ⌘↩').click();
      const request = http.expectOne({ method: 'POST', url: '/api/agent/runs' });
      expect(request.request.body).toMatchObject({ template: 'execute', agent: 'claude' });
      expect(localStorage.getItem('worklog.agent')).toBe('claude');
      request.flush({});
      await settle();
      http.expectOne({ method: 'GET', url: '/api/state' }).flush(STATE);
      await settle();
    } finally {
      localStorage.removeItem('worklog.agent');
    }
  });

  it('keeps a question on dev and does not launch it without the question', async () => {
    await useProfile();
    await open({ directionId: 'd1' });
    await answerBranch('feature/APP-6120_WEB-3380', 'local');
    button('Вопрос').click();
    await fixture.whenStable();
    expect(field('input[aria-label="Ветка"]', HTMLInputElement).value).toBe('dev');
    expect(text(host.querySelector('.as__branch-hint'))).toBe('без ветки задачи');
    expect(button('Запустить ⌘↩').disabled).toBe(true);

    type(field('textarea', HTMLTextAreaElement), 'Где читаются ключи app.*?');
    await fixture.whenStable();
    expect(button('Запустить ⌘↩').disabled).toBe(false);
    field('dialog', HTMLDialogElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
    const request = http.expectOne({ method: 'POST', url: '/api/agent/runs' });
    expect(request.request.body).toMatchObject({ template: 'question', branch: 'dev', extra: 'Где читаются ключи app.*?' });
    request.flush({ error: 'Не удалось открыть вкладку Warp: нет Warp' }, { status: 500, statusText: 'Error' });
    await settle();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(STATE);
    await settle();
    await fixture.whenStable();
    expect(text(host.querySelector('.as__failure'))).toBe('Не удалось открыть вкладку Warp: нет Warp');
    expect(sheet.target()).not.toBeNull();
  });

  it('refuses a bad branch typed by hand and closes on Отмена', async () => {
    await useProfile();
    await open({ todoId: 't2' });
    expect(text(host.querySelector('.as__title'))).toBe('✦ Поручение агенту · Без направления');
    expect(host.querySelector('.as__context')).toBeNull();
    expect(field('input[aria-label="Ветка"]', HTMLInputElement).value).toBe('dev');

    type(field('input[aria-label="Ветка"]', HTMLInputElement), 'feature/a b');
    await fixture.whenStable();
    expect(text(host.querySelector('.as__branch-hint'))).toBe('некорректное имя ветки');
    expect(button('Запустить ⌘↩').disabled).toBe(true);

    button('Отмена').click();
    expect(sheet.target()).toBeNull();
  });
});
