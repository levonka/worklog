import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import type { WorklogState } from '@worklog/model';
import { TabsStore } from '../core/tabs-store';
import { WorklogStore } from '../core/worklog-store';
import { Tour } from '../onboarding/tour';
import { UpdateStore } from '../update/update-store';
import { ICON_COLORS, Sidebar } from './sidebar';

const STATE: WorklogState = {
  directions: [],
  todos: [],
  repeats: [],
  linkGroups: [
    { id: 'g1', title: 'Каждый день', links: [{ title: 'Почта', url: 'https://mail.test' }, { title: 'почтовый ящик', url: 'https://box.test' }] },
    { id: 'g2', title: 'Разработка', links: [{ title: 'Jenkins', url: 'https://ci.test' }] },
  ],
  dailies: [],
  draft: null,
  notes: [],
  runs: [],
};

describe('Sidebar', () => {
  let fixture: ComponentFixture<Sidebar>;
  let http: HttpTestingController;
  let host: HTMLElement;

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({ imports: [Sidebar], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(STATE);
    await loading;
    fixture = TestBed.createComponent(Sidebar);
    host = fixture.nativeElement;
    await fixture.whenStable();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    try {
      http.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  function query<T extends Element>(selector: string, type: new () => T): T {
    const element = host.querySelector(selector);
    if (!(element instanceof type)) throw new Error(`${selector} not found`);
    return element;
  }

  function settle(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve));
  }

  function texts(selector: string): string[] {
    return Array.from(host.querySelectorAll(selector)).map(node => node.textContent?.trim() ?? '');
  }

  // under fake timers: the answers settle, then the view follows
  async function render(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
  }

  // every write is followed by a state refresh
  async function answerRefresh(): Promise<void> {
    await settle();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(STATE);
    await settle();
  }

  function press(input: HTMLInputElement, key: string): void {
    input.dispatchEvent(new KeyboardEvent('keydown', { key }));
  }

  it('marks open tabs and opens a tab from the navigation', async () => {
    TestBed.inject(TabsStore).closeTab('board');
    await fixture.whenStable();
    const items = Array.from(host.querySelectorAll('.sb__item'));
    expect(items.map(item => [item.textContent?.trim(), item.classList.contains('sb__item_open')])).toEqual([
      ['☑︎Дела', true],
      ['▦Доска', false],
      ['🗒︎Дейлик · 11:30', false],
      ['🕘︎История', false],
      ['✓︎Сделано', false],
      ['📖︎Знания', false],
    ]);

    query('.sb__item:nth-child(2)', HTMLButtonElement).click();
    await fixture.whenStable();

    expect(TestBed.inject(TabsStore).layout().active).toBe('board');
    expect(host.querySelector('.sb__item:nth-child(2)')?.classList.contains('sb__item_open')).toBe(true);
  });

  it('nav lists Дейлик · 11:30, История and Сделано and opens their tabs', async () => {
    query('.sb__item:nth-child(3)', HTMLButtonElement).click();
    await fixture.whenStable();
    expect(TestBed.inject(TabsStore).layout().active).toBe('daily');
    query('.sb__item:nth-child(4)', HTMLButtonElement).click();
    await fixture.whenStable();
    expect(TestBed.inject(TabsStore).layout().active).toBe('history');
    query('.sb__item:nth-child(5)', HTMLButtonElement).click();
    await fixture.whenStable();
    expect(TestBed.inject(TabsStore).layout().active).toBe('done');
    expect(TestBed.inject(TabsStore).view('daily').title).toBe('Дейлик');
  });

  it('shows links with a letter icon whose colour depends only on the title', () => {
    const links = Array.from(host.querySelectorAll('.sb__link-anchor'));
    expect(links.map(link => [link.textContent?.trim(), link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')])).toEqual([
      ['ППочта', 'https://mail.test', '_blank', 'noopener'],
      ['Ппочтовый ящик', 'https://box.test', '_blank', 'noopener'],
      ['JJenkins', 'https://ci.test', '_blank', 'noopener'],
    ]);
    const colours = Array.from(host.querySelectorAll<HTMLElement>('.sb__fav')).map(fav => fav.style.background);
    expect(colours.every(colour => colour !== '')).toBe(true);

    fixture.destroy();
    const again = TestBed.createComponent(Sidebar);
    again.detectChanges();
    expect(Array.from(again.nativeElement.querySelectorAll('.sb__fav')).map(fav => (fav instanceof HTMLElement ? fav.style.background : ''))).toEqual(colours);
  });

  it('adds a link to the group from the inline form', async () => {
    query('.sb__group:nth-of-type(2) .sb__group-add', HTMLButtonElement).click();
    await fixture.whenStable();
    const [title, url] = Array.from(host.querySelectorAll('.sb__input')).filter(input => input instanceof HTMLInputElement);
    expect(document.activeElement).toBe(title);

    title.value = 'Swagger';
    press(title, 'Enter');
    expect(document.activeElement).toBe(url);
    url.value = ' swagger.test/ui ';
    press(url, 'Enter');

    const request = http.expectOne({ method: 'POST', url: '/api/link-groups' });
    expect(request.request.body).toEqual({ groupTitle: 'Разработка', title: 'Swagger', url: 'https://swagger.test/ui' });
    request.flush({});
    await answerRefresh();
    await fixture.whenStable();

    expect(host.querySelector('.sb__form')).toBeNull();
  });

  it.each([
    ['host:port', 'dev.shop.test:4200/ru/live', 'https://dev.shop.test:4200/ru/live'],
    ['localhost with a port', 'localhost:4200', 'https://localhost:4200'],
    ['an explicit scheme', 'http://localhost:4300/', 'http://localhost:4300/'],
    ['mailto', 'mailto:team@mail.test', 'mailto:team@mail.test'],
  ])('saves %s as a link that opens', async (_case, typed, expected) => {
    query('.sb__group-add', HTMLButtonElement).click();
    await fixture.whenStable();
    const [title, url] = Array.from(host.querySelectorAll('.sb__input')).filter(input => input instanceof HTMLInputElement);
    title.value = 'Стенд';
    url.value = typed;
    press(url, 'Enter');

    const request = http.expectOne({ method: 'POST', url: '/api/link-groups' });
    expect(request.request.body).toEqual({ groupTitle: 'Каждый день', title: 'Стенд', url: expected });
    request.flush({});
    await answerRefresh();
  });

  it('closes the form on Escape without saving', async () => {
    query('.sb__group-add', HTMLButtonElement).click();
    await fixture.whenStable();

    press(query('.sb__input', HTMLInputElement), 'Escape');
    await fixture.whenStable();

    expect(host.querySelector('.sb__form')).toBeNull();
  });

  it('removes a link by its ✕', async () => {
    query('.sb__group:nth-of-type(2) .sb__remove', HTMLButtonElement).click();

    const request = http.expectOne(req => req.method === 'DELETE' && req.url === '/api/link-groups/g2/links');
    expect(request.request.params.get('url')).toBe('https://ci.test');
    request.flush(null);
    await answerRefresh();
  });

  it('a second Enter while the link is saved sends nothing more', async () => {
    query('.sb__group-add', HTMLButtonElement).click();
    await fixture.whenStable();
    const [title, url] = Array.from(host.querySelectorAll('.sb__input')).filter(input => input instanceof HTMLInputElement);
    title.value = 'Стенд';
    url.value = 'stand.test';
    press(url, 'Enter');
    press(url, 'Enter');

    const [request] = http.match({ method: 'POST', url: '/api/link-groups' });
    expect(http.match({ method: 'POST', url: '/api/link-groups' })).toEqual([]);
    request.flush({});
    await answerRefresh();
    await fixture.whenStable();
    expect(host.querySelector('.sb__form')).toBeNull();
  });

  it('a saved link closes the form only if the same group is still open', async () => {
    query('.sb__group:nth-of-type(1) .sb__group-add', HTMLButtonElement).click();
    await fixture.whenStable();
    const [title, url] = Array.from(host.querySelectorAll('.sb__input')).filter(input => input instanceof HTMLInputElement);
    title.value = 'Стенд';
    url.value = 'stand.test';
    press(url, 'Enter');
    query('.sb__group:nth-of-type(2) .sb__group-add', HTMLButtonElement).click();

    http.expectOne({ method: 'POST', url: '/api/link-groups' }).flush({});
    await answerRefresh();
    await fixture.whenStable();
    expect(host.querySelector('.sb__group:nth-of-type(2) .sb__form')).not.toBeNull();
  });

  it('icon colours come from the palette and match for the same title in different groups', async () => {
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush({
      ...STATE,
      linkGroups: [
        { id: 'g1', title: 'Раз', links: [{ title: 'Почта', url: 'https://mail.test' }] },
        { id: 'g2', title: 'Два', links: [{ title: 'Почта', url: 'https://mail2.test' }] },
      ],
    });
    await loading;
    await fixture.whenStable();

    const probe = document.createElement('span');
    const palette = ICON_COLORS.map(colour => {
      probe.style.background = colour;
      return probe.style.background;
    });
    const [first, second] = Array.from(host.querySelectorAll<HTMLElement>('.sb__fav')).map(fav => fav.style.background);
    expect(palette).toContain(first);
    expect(second).toBe(first);
  });

  it('ⓘ unfolds a link description and a link without one opens straight into its field', async () => {
    const described: WorklogState = {
      ...STATE,
      linkGroups: [{ id: 'g1', title: 'Корпоративное', links: [{ title: 'КЭДО', url: 'https://ks.test/', description: 'Кадровые документы: `отпуска`' }, { title: 'GLPI', url: 'https://it.test/' }] }],
    };
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(described);
    await loading;
    await fixture.whenStable();

    const [kedo, glpi] = Array.from(host.querySelectorAll('.sb__info'));
    expect([kedo.textContent, glpi.textContent]).toEqual(['ⓘ', '✎']);
    expect(query('.sb__link-anchor', HTMLAnchorElement).title).toBe('Кадровые документы: `отпуска`');

    (kedo as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(query('.sb__desc .rt__code', HTMLElement).textContent).toBe('отпуска');

    (glpi as HTMLButtonElement).click();
    await fixture.whenStable();
    const field = query('.sb__desc textarea', HTMLTextAreaElement);
    field.value = '  Заявки в IT ';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
    await settle();
    const request = http.expectOne({ method: 'PATCH', url: '/api/link-groups/g1/links' });
    expect(request.request.body).toEqual({ url: 'https://it.test/', description: 'Заявки в IT' });
    request.flush({});
    await answerRefresh();
  });

  it('Как пользоваться sits at the very bottom, under the link groups, not among the sections', () => {
    expect(host.querySelector('.sb__nav .sb__foot-link')).toBeNull();
    expect(host.lastElementChild?.lastElementChild?.textContent?.trim()).toBe('Как пользоваться');
  });

  it('the bottom holds Разобрать вкладки Chrome, then Как пользоваться', () => {
    expect(texts('.sb__foot button')).toEqual(['Разобрать вкладки Chrome', 'Как пользоваться']);
  });

  it('Проверить обновления checks now and tells the result for two seconds', async () => {
    expect(texts('.sb__foot-link')).toEqual(['Как пользоваться']);
    vi.useFakeTimers();
    const updates = TestBed.inject(UpdateStore);
    const loading = updates.load();
    http.expectOne({ method: 'GET', url: '/api/update' }).flush({ check: 'none', version: 'aaa111', run: null });
    await loading;
    await render();
    const check = query('.sb__foot-link', HTMLButtonElement);
    expect(check.textContent?.trim()).toBe('Проверить обновления');

    const answers = [
      ['none', 'none', 'Новой версии нет'],
      ['unreachable', 'none', 'Не удалось проверить'],
      ['available', 'available', 'Есть новая версия'],
    ] as const;
    for (const [result, found, text] of answers) {
      check.click();
      await render();
      expect(check.textContent?.trim()).toBe('Проверяю…');
      expect(check.disabled).toBe(true);
      http.expectOne({ method: 'POST', url: '/api/update/check' }).flush({ result, status: { check: found, version: 'aaa111', run: null } });
      await render();
      expect(check.textContent?.trim()).toBe(text);

      await vi.advanceTimersByTimeAsync(2_000);
      await render();
      expect(check.textContent?.trim()).toBe('Проверить обновления');
      expect(check.disabled).toBe(false);
    }
    expect(updates.status()?.check).toBe('available');
  });

  it('Как пользоваться starts the tour and brings hidden first steps back while something is left', async () => {
    const start = vi.spyOn(TestBed.inject(Tour), 'start').mockImplementation(() => undefined);
    const help = query('.sb__foot-link:last-child', HTMLButtonElement);
    expect(help.textContent?.trim()).toContain('Как пользоваться');

    help.click();
    expect(start).toHaveBeenCalledTimes(1);

    const store = TestBed.inject(WorklogStore);
    const loading = store.refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush({ ...STATE, onboarding: { stepsHidden: true } });
    await loading;
    help.click();
    expect(start).toHaveBeenCalledTimes(2);
    const request = http.expectOne({ method: 'PATCH', url: '/api/onboarding' });
    expect(request.request.body).toEqual({ stepsHidden: false });
    request.flush({});
    await answerRefresh();
  });

  it('Как пользоваться leaves the first steps alone once they were all done', async () => {
    vi.spyOn(TestBed.inject(Tour), 'start').mockImplementation(() => undefined);
    const store = TestBed.inject(WorklogStore);
    const loading = store.refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush({ ...STATE, onboarding: { stepsHidden: true, stepsDoneAt: '2026-11-13T09:00:00.000Z' } });
    await loading;

    query('.sb__foot-link:last-child', HTMLButtonElement).click();

    http.expectNone({ method: 'PATCH', url: '/api/onboarding' });
  });

  it('Как пользоваться leaves first steps hidden when all of them are done', async () => {
    vi.spyOn(TestBed.inject(Tour), 'start').mockImplementation(() => undefined);
    const done: WorklogState = {
      ...STATE,
      directions: [{ id: 'd', title: 'Карта', status: 'in_progress', tickets: [], links: [], order: 0, createdAt: '2026-11-01T09:00:00.000Z', updatedAt: '2026-11-01T09:00:00.000Z', events: [{ id: 'e', at: '2026-11-01T09:00:00.000Z', text: 'Разобрал BRD', source: 'manual', kind: 'note' }] }],
      todos: [{ id: 't', text: 'Дело', done: false, createdAt: '2026-11-01T09:00:00.000Z' }],
      onboarding: { stepsHidden: true, tabsReadAt: '2026-11-01T09:00:00.000Z' },
    };
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(done);
    await loading;

    query('.sb__foot-link:last-child', HTMLButtonElement).click();

    http.expectNone({ method: 'PATCH', url: '/api/onboarding' });
  });
});
