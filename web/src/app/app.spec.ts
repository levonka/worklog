import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { EMPTY_STATE } from '@worklog/model';
import { App } from './app';
import { LiveUpdates } from './core/live-updates';
import { TabsStore } from './core/tabs-store';
import { WorklogStore } from './core/worklog-store';

const STATE_REQUEST = { method: 'GET', url: '/api/state' };

function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve));
}

describe('App', () => {
  const start = vi.fn();
  const connected = signal(true);
  let fixture: ComponentFixture<App>;
  let http: HttpTestingController;

  beforeEach(async () => {
    start.mockReset();
    connected.set(true);
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [App],
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: LiveUpdates, useValue: { start, connected } }],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    http.expectOne({ method: 'GET', url: '/api/profile' }).flush({ profile: null });
  });

  afterEach(() => {
    try {
      http.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  function strip(): HTMLElement | null {
    return fixture.nativeElement.querySelector('.rt__problem');
  }

  function closeButton(): HTMLButtonElement | null {
    return fixture.nativeElement.querySelector('.rt__problem-close');
  }

  it('loads the state and starts live updates on start', async () => {
    http.expectOne(STATE_REQUEST).flush(EMPTY_STATE);
    await fixture.whenStable();

    expect(start).toHaveBeenCalledOnce();
    expect(strip()).toBeNull();
  });

  it('the strip shows why the state could not be loaded', async () => {
    http.expectOne(STATE_REQUEST).flush({ error: 'Повреждён файл данных: /d/todos.json' }, { status: 500, statusText: 'Internal Server Error' });
    await settle();
    await fixture.whenStable();

    expect(strip()?.getAttribute('role')).toBe('alert');
    expect(strip()?.textContent?.trim()).toBe('Повреждён файл данных: /d/todos.json');
    expect(closeButton()).toBeNull();
  });

  it('the strip says there is no connection while the live stream is down', async () => {
    http.expectOne(STATE_REQUEST).flush(EMPTY_STATE);
    connected.set(false);
    await fixture.whenStable();

    expect(strip()?.textContent?.trim()).toBe('Нет связи с сервером Worklog');
    expect(closeButton()).toBeNull();

    connected.set(true);
    await fixture.whenStable();
    expect(strip()).toBeNull();
  });

  it('only a failed change gets ✕, and a lost connection takes precedence over it', async () => {
    http.expectOne(STATE_REQUEST).flush(EMPTY_STATE);
    const deleting = TestBed.inject(WorklogStore).deleteTodo('t1');
    const failed = expect(deleting).rejects.toMatchObject({ status: 404 });
    http.expectOne({ method: 'DELETE', url: '/api/todos/t1' }).flush({ error: 'Дело не найдено: t1' }, { status: 404, statusText: 'Not Found' });
    await settle();
    http.expectOne(STATE_REQUEST).flush(EMPTY_STATE);
    await failed;
    await fixture.whenStable();

    expect(strip()?.textContent).toContain('Дело не найдено: t1');
    expect(closeButton()).not.toBeNull();

    connected.set(false);
    await fixture.whenStable();
    expect(strip()?.textContent?.trim()).toBe('Нет связи с сервером Worklog');
    expect(closeButton()).toBeNull();

    connected.set(true);
    await fixture.whenStable();
    closeButton()?.click();
    await fixture.whenStable();
    expect(strip()).toBeNull();
  });

  it('⌘W anywhere in the window closes the focused tab instead of the window', async () => {
    http.expectOne(STATE_REQUEST).flush(EMPTY_STATE);
    await fixture.whenStable();
    const close = new KeyboardEvent('keydown', { code: 'KeyW', metaKey: true, bubbles: true, cancelable: true });

    document.body.dispatchEvent(close);

    expect(close.defaultPrevented).toBe(true);
    expect(TestBed.inject(TabsStore).layout().tabs).toEqual(['todos']);
  });

  it('starts the tour once the state has loaded', async () => {
    http.expectOne(STATE_REQUEST).flush({ ...EMPTY_STATE, directions: [] });
    await new Promise(resolve => setTimeout(resolve));
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector('.tu__title')?.textContent).toBe('Это Worklog');
    // keyboard focus stays in the bubble: the window under the dim takes no Tab or Space
    expect(fixture.nativeElement.querySelector('wl-sidebar')?.hasAttribute('inert')).toBe(true);
    expect(fixture.nativeElement.querySelector('.rt__main')?.hasAttribute('inert')).toBe(true);
  });

  it('does not start the tour after it was closed', async () => {
    http.expectOne(STATE_REQUEST).flush({ ...EMPTY_STATE, onboarding: { tourClosedAt: '2026-11-13T09:00:00.000Z' } });
    await new Promise(resolve => setTimeout(resolve));
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector('.tu__bubble')).toBeNull();
    expect(fixture.nativeElement.querySelector('.rt__main')?.hasAttribute('inert')).toBe(false);
  });
});
