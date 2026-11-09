import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import type { Ticket } from '@worklog/model';
import { envCopyText, envUrl, storybookLinks, ticketFromKey } from '@worklog/model';
import { TEST_PROFILE } from '@worklog/test-profile';
import { ProfileStore } from '../core/profile-store';
import { EnvLinks } from './env-links';

const B = 'feature/APP-9355_WEB-5586';

function ticket(key: string, segments?: string[]): Ticket {
  const base = ticketFromKey(key, TEST_PROFILE);
  return segments === undefined ? base : { ...base, jira: { status: 'Open', segments, at: '2026-11-06T09:00:00.000Z' } };
}

function url(platform: string, row: 'stand' | 'build', segment: string): string | null {
  return envUrl(platform, row, segment, B, TEST_PROFILE);
}

describe('EnvLinks', () => {
  let fixture: ComponentFixture<EnvLinks>;
  let host: HTMLElement;
  let writeText: ReturnType<typeof vi.fn>;

  async function setup(tickets: Ticket[]): Promise<void> {
    const http = TestBed.inject(HttpTestingController);
    const profile = TestBed.inject(ProfileStore).load();
    http.expectOne({ method: 'GET', url: '/api/profile' }).flush({ profile: TEST_PROFILE });
    await profile;
    fixture = TestBed.createComponent(EnvLinks);
    fixture.componentRef.setInput('tickets', tickets);
    fixture.componentRef.setInput('branch', B);
    host = fixture.nativeElement;
    await fixture.whenStable();
  }

  function text(element: Element | null): string {
    return (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  function columns(): string[] {
    return Array.from(host.querySelectorAll('.el__col')).map(text);
  }

  function cells(): HTMLAnchorElement[] {
    return Array.from(host.querySelectorAll('a.el__cell')).filter(cell => cell instanceof HTMLAnchorElement);
  }

  function button(label: string): HTMLButtonElement {
    const found = Array.from(host.querySelectorAll('button')).find(candidate => text(candidate) === label);
    if (!(found instanceof HTMLButtonElement)) throw new Error(`button "${label}" not found`);
    return found;
  }

  async function click(target: HTMLElement): Promise<void> {
    target.click();
    await vi.advanceTimersByTimeAsync(0);
    await fixture.whenStable();
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    TestBed.configureTestingModule({ imports: [EnvLinks], providers: [provideHttpClient(), provideHttpClientTesting()] });
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('shows only Segment columns', async () => {
    await setup([ticket('APP-9355', ['EU']), ticket('WEB-5586', ['EU'])]);

    expect(columns()).toEqual(['EU']);
    expect(cells().map(cell => cell.getAttribute('href'))).toEqual([url('App', 'stand', 'EU'), url('App', 'build', 'EU'), url('Web', 'stand', 'EU')]);
    for (const cell of cells()) {
      expect(cell.title).toBe(cell.getAttribute('href'));
      expect(cell.target).toBe('_blank');
      expect(cell.rel).toBe('noopener');
    }
    expect(button('＋ US')).toBeTruthy();
  });

  it('expands to every profile segment and collapses back', async () => {
    await setup([ticket('APP-9355', ['EU']), ticket('WEB-5586', ['EU'])]);

    await click(button('＋ US'));
    expect(columns()).toEqual(['EU', 'US']);
    expect(cells().length).toBe(6);
    const off = cells().filter(cell => cell.classList.contains('el__cell_off'));
    expect(off.length).toBe(3);
    expect(off.every(cell => cell.classList.contains('el__cell'))).toBe(true);

    await click(button('− свернуть'));
    expect(cells().length).toBe(3);
  });

  it('an empty cell where the group has no such segment', async () => {
    await setup([ticket('APP-9355', ['EU', 'US']), ticket('WEB-5586', ['EU'])]);

    expect(columns()).toEqual(['EU', 'US']);
    expect(cells().map(cell => cell.getAttribute('href'))).toEqual([
      url('App', 'stand', 'EU'),
      url('App', 'stand', 'US'),
      url('App', 'build', 'EU'),
      url('App', 'build', 'US'),
      url('Web', 'stand', 'EU'),
    ]);
  });

  it('a segment outside the profile only means nothing visible', async () => {
    await setup([ticket('APP-9251', ['ZZ'])]);

    expect(columns()).toEqual([]);
    expect(cells()).toEqual([]);
    expect(Array.from(host.querySelectorAll('.el__group')).map(text)).toEqual(['App ⧉']);
    expect(button('＋ EU, US')).toBeTruthy();
  });

  it('no statuses yet means every profile segment', async () => {
    await setup([ticket('APP-9355'), ticket('WEB-5586')]);

    expect(columns()).toEqual(['EU', 'US']);
    expect(cells().length).toBe(6);
    expect(host.querySelector('.el__more')).toBeNull();
  });

  it('only platforms with tickets', async () => {
    await setup([ticket('APP-9355', ['EU']), ticket('SHOP-8221')]);

    expect(Array.from(host.querySelectorAll('.el__group')).map(text)).toEqual(['App ⧉']);
    expect(cells().length).toBe(2);
  });

  it('a platform without build templates has no build row', async () => {
    await setup([ticket('WEB-5586', ['EU'])]);

    expect(Array.from(host.querySelectorAll('.el__row')).map(text)).toEqual(['Стенд']);
  });

  it('the group header copies the visible columns as plain text', async () => {
    await setup([ticket('APP-9355', ['EU']), ticket('WEB-5586', ['EU'])]);
    const header = button('App ⧉');
    expect(text(header)).not.toContain('скопировать');

    await click(header);
    expect(writeText).toHaveBeenCalledWith(envCopyText('App', ['EU'], B, TEST_PROFILE));
    expect(text(host.querySelector('.el__copied'))).toBe('Скопировано: App, 2 ссылки');

    await click(button('＋ US'));
    await click(button('App ⧉'));
    expect(writeText).toHaveBeenLastCalledWith(envCopyText('App', ['EU', 'US'], B, TEST_PROFILE));
    expect(text(host.querySelector('.el__copied'))).toBe('Скопировано: App, 4 ссылки');

    await vi.advanceTimersByTimeAsync(2000);
    await fixture.whenStable();
    expect(host.querySelector('.el__copied')).toBeNull();
  });

  it('storybook links under the table', async () => {
    await setup([ticket('APP-9355', ['EU'])]);

    const links = Array.from(host.querySelectorAll('.el__storybook a')).filter(link => link instanceof HTMLAnchorElement);
    expect(links.map(link => ({ title: text(link), url: link.getAttribute('href') }))).toEqual(storybookLinks(B, TEST_PROFILE));
  });
});
