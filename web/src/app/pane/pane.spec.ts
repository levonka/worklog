import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import type { Direction, WorklogState } from '@worklog/model';
import { TabsStore } from '../core/tabs-store';
import { WorklogStore } from '../core/worklog-store';
import { Pane } from './pane';

const AT = '2026-11-01T09:00:00.000Z';

function direction(id: string, title: string): Direction {
  return { id, title, status: 'in_progress', tickets: [], links: [], events: [], order: 0, createdAt: AT, updatedAt: AT };
}

const STATE: WorklogState = { directions: [direction('seo', 'SEO-текст'), direction('unify', 'Переезд сервисов')], todos: [], repeats: [], linkGroups: [], dailies: [], draft: null, notes: [], runs: [] };

describe('Pane', () => {
  let fixture: ComponentFixture<Pane>;
  let host: HTMLElement;

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({ imports: [Pane], providers: [provideHttpClient(), provideHttpClientTesting()] });
    const http = TestBed.inject(HttpTestingController);
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(STATE);
    await loading;
    const tabs = TestBed.inject(TabsStore);
    tabs.openTab('direction:seo');
    tabs.openTab('direction:unify');
    tabs.splitRight('direction:seo');
    fixture = TestBed.createComponent(Pane);
    fixture.componentRef.setInput('tabId', 'direction:seo');
    host = fixture.nativeElement;
    await fixture.whenStable();
  });

  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  function eventField(): HTMLInputElement {
    const field = host.querySelector('input[aria-label="Что произошло?"]');
    if (!(field instanceof HTMLInputElement)) throw new Error('event field not found');
    return field;
  }

  it("shows a direction tab as its direction view, with the pane's ⇥ in the view's header", () => {
    expect(host.querySelector('.dv__title')?.textContent?.trim()).toBe('SEO-текст');
    expect(host.querySelector('.dv__bar .pn__btn[aria-label="Убрать разделение"]')).not.toBeNull();
    expect(host.querySelector('.pn__bar')).toBeNull();
  });

  it('opens another direction in a fresh view, without the text typed for the first one', async () => {
    eventField().value = 'Олег подтвердил';

    fixture.componentRef.setInput('tabId', 'direction:unify');
    await fixture.whenStable();

    expect(host.querySelector('.dv__title')?.textContent?.trim()).toBe('Переезд сервисов');
    expect(eventField().value).toBe('');
  });

  it('after the reload into a new version returns to the saved scroll once', async () => {
    expect(host.getAttribute('data-tab-id')).toBe('direction:seo');
    sessionStorage.setItem('worklog.scroll.v1', JSON.stringify({ savedAt: Date.now(), panes: { 'direction:unify': [['div.pn__body#0', 30, 0]] } }));

    const other = TestBed.createComponent(Pane);
    other.componentRef.setInput('tabId', 'direction:unify');
    await other.whenStable();

    expect(other.nativeElement.querySelector('.pn__body').scrollTop).toBe(30);
    expect(JSON.parse(sessionStorage.getItem('worklog.scroll.v1') ?? 'null')?.panes).toEqual({});
    sessionStorage.clear();
  });

  it('using a pane focuses its tab, for ⌘W', () => {
    const tabs = TestBed.inject(TabsStore);
    tabs.focus('direction:unify');

    host.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(tabs.focusedTab()).toBe('direction:seo');

    tabs.focus('direction:unify');
    eventField().focus();
    expect(tabs.focusedTab()).toBe('direction:seo');
  });
});
