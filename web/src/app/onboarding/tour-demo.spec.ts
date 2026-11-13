import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import type { Direction, WorklogState } from '@worklog/model';
import { TabsStore } from '../core/tabs-store';
import { WorklogStore } from '../core/worklog-store';
import { Tour } from './tour';
import { TourDemo } from './tour-demo';
import type { TourDemoKind } from './tour-steps';

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

const STATE: WorklogState = {
  directions: [EXAMPLE],
  todos: [{ id: 't1', text: 'Уточнить текст ошибки', done: false, createdAt: AT }],
  repeats: [],
  linkGroups: [],
  dailies: [],
  draft: null,
  notes: [],
  runs: [],
};

@Component({
  imports: [TourDemo],
  template: `<wl-tour-demo [demo]="demo()" />`,
})
class Host {
  readonly demo = signal<TourDemoKind>('todo-card');
}

function box(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) };
}

describe('TourDemo', () => {
  let http: HttpTestingController;
  let page: HTMLElement;

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(STATE);
    await loading;
    page = document.createElement('div');
    document.body.append(page);
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

  function element(html: string, rect: DOMRect): HTMLElement {
    const holder = document.createElement('div');
    holder.innerHTML = html;
    page.append(holder);
    const found = holder.querySelector<HTMLElement>('[data-todo-id], [data-direction-id], .tb__tab, .rt__panes, [data-tour]');
    if (found === null) throw new Error(`Нет элемента в ${html}`);
    vi.spyOn(found, 'getBoundingClientRect').mockReturnValue(rect);
    return found;
  }

  async function render(demo: TourDemoKind): Promise<{ fixture: ComponentFixture<Host>; host: HTMLElement }> {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.demo.set(demo);
    await fixture.whenStable();
    return { fixture, host: fixture.nativeElement };
  }

  function variables(ghost: HTMLElement | null): string[] {
    return ['--from-x', '--from-y', '--to-x', '--to-y'].map(name => ghost?.style.getPropertyValue(name) ?? '');
  }

  it('carries a ghost of the first todo onto the card of the tour and back', async () => {
    TestBed.inject(Tour).start();
    const layout = TestBed.inject(TabsStore).layout();
    element('<div class="tl__list"><div data-todo-id="t1"></div></div>', box(600, 100, 300, 30));
    element('<div data-direction-id="ex"></div>', box(20, 200, 200, 80));

    const { host } = await render('todo-card');

    const ghosts = Array.from(host.querySelectorAll<HTMLElement>('.td__ghost'));
    expect(ghosts.map(ghost => ghost.textContent?.trim())).toEqual(['Уточнить текст ошибки', 'Пример: капча на входе']);
    // the todo ghost is 220 × 30: centred on the row, then on the card
    expect(variables(ghosts[0])).toEqual(['640px', '100px', '10px', '225px']);
    expect(variables(ghosts[1])).toEqual(['20px', '218px', '650px', '93px']);
    expect(host.querySelectorAll('.td__zone')).toHaveLength(2);
    expect(TestBed.inject(TabsStore).layout()).toEqual(layout);
  });

  it('carries the active tab into the right third of the panes', async () => {
    element('<div class="tb__tab tb__tab_on"><span class="tb__title">Доска</span></div>', box(100, 10, 120, 28));
    element('<div class="rt__panes"></div>', box(0, 40, 900, 600));

    const { host } = await render('tab-split');

    const ghost = host.querySelector<HTMLElement>('.td__ghost');
    expect(ghost?.textContent?.trim()).toBe('Доска');
    expect(variables(ghost)).toEqual(['100px', '10px', '690px', '326px']);
    const zone = host.querySelector<HTMLElement>('.td__zone');
    expect([zone?.style.left, zone?.style.top, zone?.style.width, zone?.style.height]).toEqual(['600px', '40px', '300px', '600px']);
    expect(zone?.textContent?.trim()).toBe('Открыть справа');
  });

  it('prefers a tab that is not on screen', async () => {
    element('<div class="tb__tab tb__tab_on"><span class="tb__title">Доска</span></div>', box(100, 10, 120, 28));
    element('<div class="tb__tab"><span class="tb__title">Знания</span></div>', box(230, 10, 120, 28));
    element('<div class="rt__panes"></div>', box(0, 40, 900, 600));

    const { host } = await render('tab-split');

    expect(host.querySelector('.td__ghost')?.textContent?.trim()).toBe('Знания');
  });

  it('draws nothing without the source and does not throw', async () => {
    TestBed.inject(Tour).start();

    const { host } = await render('todo-card');
    expect(host.querySelector('.td__ghost')).toBeNull();

    const tabs = await render('tab-split');
    expect(tabs.host.querySelector('.td__ghost')).toBeNull();
  });
});
