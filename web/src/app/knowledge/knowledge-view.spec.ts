import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import type { Direction, Note, WorklogState } from '@worklog/model';
import { ticketFromKey } from '@worklog/model';
import { TabsStore } from '../core/tabs-store';
import { WorklogStore } from '../core/worklog-store';
import { KnowledgeView } from './knowledge-view';
import { shortFileLabel } from './note-card';
import { TEST_PROFILE } from '@worklog/test-profile';

const AT = '2026-11-05T09:00:00.000Z';

function direction(id: string, title: string, key: string): Direction {
  return { id, title, status: 'in_progress', tickets: [ticketFromKey(key, TEST_PROFILE)], links: [], events: [], order: 0, createdAt: AT, updatedAt: AT };
}

function note(id: string, title: string, updatedAt: string, fields: Partial<Note> = {}): Note {
  return { id, title, body: '', directionIds: [], files: [], urls: [], createdAt: AT, updatedAt, ...fields };
}

const STATE: WorklogState = {
  directions: [direction('by', 'US пуши', 'APP-9508')],
  todos: [],
  repeats: [],
  linkGroups: [],
  dailies: [],
  draft: null,
  notes: [
    note('old', 'Капча: дока API', '2026-11-01T09:00:00.000Z', { urls: [{ url: 'https://wiki.test/captcha' }] }),
    note('new', 'Общий origin', '2026-11-05T09:00:00.000Z', {
      body: 'Ключи `app.*`',
      directionIds: ['by'],
      files: [{ path: 'libs/local-storage/README.md' }, { path: 'libs/push/push-token.service.ts', line: 42 }],
    }),
  ],
  runs: [],
};

describe('shortFileLabel', () => {
  it('keeps the folder of a generic file name and the line', () => {
    expect(shortFileLabel({ path: 'libs/local-storage/README.md' })).toBe('local-storage/README.md');
    expect(shortFileLabel({ path: 'libs/push/push-token.service.ts', line: 42 })).toBe('push-token.service.ts:42');
    expect(shortFileLabel({ path: 'README.md' })).toBe('README.md');
  });
});

describe('KnowledgeView', () => {
  let fixture: ComponentFixture<KnowledgeView>;
  let http: HttpTestingController;
  let host: HTMLElement;

  function settle(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve));
  }

  // the view checks on opening and the service again when it first sees the notes
  async function answerMissing(missing: string[] = []): Promise<void> {
    for (let round = 0; round < 3; round++) {
      await settle();
      await fixture.whenStable();
      for (const request of http.match({ method: 'GET', url: '/api/note-files/missing' })) request.flush({ missing });
    }
    await fixture.whenStable();
  }

  async function answerRefresh(): Promise<void> {
    await settle();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(STATE);
    await answerMissing();
  }

  function titles(): string[] {
    return Array.from(host.querySelectorAll('.nc__title')).map(title => title.textContent?.trim() ?? '');
  }

  function query<T extends Element>(selector: string, type: new () => T): T {
    const element = host.querySelector(selector);
    if (!(element instanceof type)) throw new Error(`${selector} not found`);
    return element;
  }

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({ imports: [KnowledgeView], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    const loading = TestBed.inject(WorklogStore).refresh();
    http.expectOne({ method: 'GET', url: '/api/state' }).flush(STATE);
    await loading;
    fixture = TestBed.createComponent(KnowledgeView);
    host = fixture.nativeElement;
    await fixture.whenStable();
    await answerMissing(['libs/push/push-token.service.ts']);
  });

  afterEach(() => {
    localStorage.clear();
    try {
      http.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  it('lists notes newest first with links, marks a missing file and opens its direction', async () => {
    expect(titles()).toEqual(['Общий origin', 'Капча: дока API']);
    const files = Array.from(host.querySelectorAll('.nc__file'));
    expect(files.map(f => [f.textContent, f.classList.contains('nc__file_missing')])).toEqual([
      ['local-storage/README.md', false],
      ['push-token.service.ts:42', true],
    ]);
    expect(query('.nc__url', HTMLAnchorElement).textContent).toBe('wiki.test');

    query('.nc__dir', HTMLButtonElement).click();
    expect(TestBed.inject(TabsStore).layout().active).toBe('direction:by');
  });

  it('searches by words, files and the tickets of directions', async () => {
    const search = query('.kv__search', HTMLInputElement);
    for (const [text, expected] of [
      ['app-9508', ['Общий origin']],
      ['push-token', ['Общий origin']],
      ['капча', ['Капча: дока API']],
      ['нет такого', []],
    ] as const) {
      search.value = text;
      search.dispatchEvent(new Event('input'));
      await fixture.whenStable();
      expect(titles()).toEqual(expected);
    }
    expect(host.querySelector('.kv__empty')?.textContent?.trim()).toBe('Ничего не нашлось');
  });

  it('a file link asks the server to open it in the editor', async () => {
    query('.nc__file', HTMLButtonElement).click();
    await settle();
    const request = http.expectOne({ method: 'POST', url: '/api/open-file' });
    expect(request.request.body).toEqual({ path: 'libs/local-storage/README.md' });
    request.flush(null);
    await answerRefresh();
  });

  it('creates a note with parsed links and refuses a link it does not understand', async () => {
    query('.kv__add', HTMLButtonElement).click();
    await fixture.whenStable();
    query('.ne__title', HTMLInputElement).value = 'Новая';
    query('.ne__field_body', HTMLTextAreaElement).value = 'Текст';
    const links = query('.ne__field_links', HTMLTextAreaElement);
    links.value = 'libs/a.ts:3\n../secret';
    query('.ne__btn_primary', HTMLButtonElement).click();
    await fixture.whenStable();
    expect(query('.ne__error', HTMLElement).textContent).toContain('Не понял ссылку: ../secret');

    links.value = 'libs/a.ts:3\n\nhttps://wiki.test/brd BRD';
    const select = query('.ne__select', HTMLSelectElement);
    select.value = 'by';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    query('.ne__btn_primary', HTMLButtonElement).click();
    await settle();
    const request = http.expectOne({ method: 'POST', url: '/api/notes' });
    expect(request.request.body).toEqual({
      title: 'Новая',
      body: 'Текст',
      directionIds: ['by'],
      files: [{ path: 'libs/a.ts', line: 3 }],
      urls: [{ url: 'https://wiki.test/brd', title: 'BRD' }],
    });
    request.flush(note('n3', 'Новая', AT));
    await answerRefresh();
    expect(host.querySelector('wl-note-editor')).toBeNull();
  });
});
