import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import type { WorklogState } from '@worklog/model';
import { baseBranch, EMPTY_STATE } from '@worklog/model';
import { TEST_PROFILE } from '@worklog/test-profile';
import type { AgentLauncher } from '../core/api';
import { ProfileStore } from '../core/profile-store';
import { WorklogStore } from '../core/worklog-store';
import { ChromeTabs } from './chrome-tabs';

const STATE: WorklogState = { ...EMPTY_STATE, directions: [], todos: [] };
const LAUNCHER: AgentLauncher = { terminal: 'warp', codeRoot: '~/Projects/app', agents: ['claude'], defaultAgent: 'claude' };

describe('ChromeTabs', () => {
  let fixture: ComponentFixture<ChromeTabs>;
  let http: HttpTestingController;
  let host: HTMLElement;

  function settle(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve));
  }

  function text(element: Element | null): string {
    return (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  function query<T extends Element>(selector: string, type: new () => T): T {
    const element = host.querySelector(selector);
    if (!(element instanceof type)) throw new Error(`${selector} not found`);
    return element;
  }

  async function render(): Promise<void> {
    await settle();
    await fixture.whenStable();
  }

  /** opens the bubble and answers the launcher request */
  async function open(launcher: AgentLauncher | null = LAUNCHER): Promise<void> {
    query('.ct__button', HTMLButtonElement).click();
    await render();
    const request = http.expectOne({ method: 'GET', url: '/api/agent/launcher' });
    if (launcher === null) request.flush({ error: 'Запуск агента не настроен' }, { status: 503, statusText: 'Unavailable' });
    else request.flush(launcher);
    await render();
  }

  beforeEach(async () => {
    TestBed.configureTestingModule({ imports: [ChromeTabs], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    const profileLoading = TestBed.inject(ProfileStore).load();
    http.expectOne({ method: 'GET', url: '/api/profile' }).flush({ profile: TEST_PROFILE });
    await profileLoading;
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(STATE);
    await loading;
    fixture = TestBed.createComponent(ChromeTabs);
    host = fixture.nativeElement;
    document.body.append(host);
    await fixture.whenStable();
  });

  afterEach(() => {
    host.remove();
    try {
      http.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  it('opens a bubble with the explanation, the phrase and Запустить агента when the launch is set up', async () => {
    expect(host.querySelector('.ct__pop')).toBeNull();
    await open();
    expect(query('.ct__button', HTMLButtonElement).getAttribute('aria-expanded')).toBe('true');
    expect(text(host.querySelector('.ct__text'))).toContain('запишет только после вашего «да»');
    expect(text(host.querySelector('.pr__text'))).toBe('разбери вкладки chrome в worklog');
    expect(text(host.querySelector('.ct__launch'))).toBe('Запустить агента');
    expect(text(host.querySelector('.ct__hint'))).toBe('Откроется новая вкладка Warp');
  });

  it('offers only the phrase when the launch is not set up', async () => {
    await open(null);
    expect(host.querySelector('.ct__pop')).not.toBeNull();
    expect(host.querySelector('.ct__launch')).toBeNull();
    expect(text(host.querySelector('.pr__text'))).toBe('разбери вкладки chrome в worklog');
  });

  it('Запустить агента starts the tabs run and closes the bubble', async () => {
    await open();
    query('.ct__launch', HTMLButtonElement).click();
    await render();
    expect(query('.ct__launch', HTMLButtonElement).disabled).toBe(true);
    const request = http.expectOne({ method: 'POST', url: '/api/agent/runs' });
    expect(request.request.body).toStrictEqual({ template: 'tabs', include: [], extra: '', branch: baseBranch(TEST_PROFILE), agent: 'claude' });
    request.flush({});
    await settle();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(STATE);
    await render();
    expect(host.querySelector('.ct__pop')).toBeNull();
  });

  it('closes on Escape, on a click outside and on the button again', async () => {
    await open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await render();
    expect(host.querySelector('.ct__pop')).toBeNull();

    await open();
    query('.ct__text', HTMLParagraphElement).dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await render();
    expect(host.querySelector('.ct__pop')).not.toBeNull();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await render();
    expect(host.querySelector('.ct__pop')).toBeNull();

    await open();
    query('.ct__button', HTMLButtonElement).click();
    await render();
    expect(host.querySelector('.ct__pop')).toBeNull();
    expect(query('.ct__button', HTMLButtonElement).getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the bubble at the button while the sidebar scrolls', async () => {
    const sidebar = document.createElement('nav');
    document.body.append(sidebar);
    sidebar.append(host);
    const box = vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 300, 200, 30));
    await open();
    expect(query('.ct__pop', HTMLDivElement).style.bottom).toBe(`${window.innerHeight - 330}px`);

    box.mockReturnValue(new DOMRect(0, 200, 200, 30));
    sidebar.dispatchEvent(new Event('scroll'));
    await render();

    expect(query('.ct__pop', HTMLDivElement).style.bottom).toBe(`${window.innerHeight - 230}px`);
    sidebar.remove();
  });

  it('shows why the launch failed', async () => {
    await open();
    query('.ct__launch', HTMLButtonElement).click();
    await render();
    http.expectOne({ method: 'POST', url: '/api/agent/runs' }).flush({ error: 'Терминал не открылся' }, { status: 500, statusText: 'Error' });
    await settle();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(STATE);
    await render();
    expect(text(host.querySelector('.ct__failure'))).toBe('Терминал не открылся');
    expect(host.querySelector('.ct__pop')).not.toBeNull();
    expect(query('.ct__launch', HTMLButtonElement).disabled).toBe(false);
  });
});
