import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import type { Direction } from '@worklog/model';
import { DropHint } from '../core/drop-hint';
import { DirectionCard } from './direction-card';

const AT = '2026-11-01T09:00:00.000Z';

function direction(fields: Partial<Direction> = {}): Direction {
  return { id: 'seo', title: 'SEO-текст', status: 'in_progress', tickets: [], links: [], events: [], order: 0, createdAt: AT, updatedAt: AT, ...fields };
}

describe('DirectionCard', () => {
  let fixture: ComponentFixture<DirectionCard>;
  let host: HTMLElement;

  async function render(value: Direction): Promise<void> {
    fixture = TestBed.createComponent(DirectionCard);
    fixture.componentRef.setInput('direction', value);
    host = fixture.nativeElement;
    await fixture.whenStable();
  }

  afterEach(() => TestBed.resetTestingModule());

  it('a marked card shows its stage', async () => {
    await render(direction({ status: 'waiting', waitingFor: 'девопсы', stage: 'testing' }));
    expect(host.querySelector('.dc__stage')?.textContent?.trim()).toBe('Тестирование');
    await render(direction({ status: 'testing', stage: 'testing' }));
    expect(host.querySelector('.dc__stage')).toBeNull();
  });

  it('a direction from an old file shows its status as the stage', async () => {
    await render(direction({ status: 'parked' }));
    expect(host.querySelector('.dc__stage')?.textContent?.trim()).toBe('В работе');
  });

  it('is marked while a todo is dragged over it', async () => {
    await render(direction());
    const hint = TestBed.inject(DropHint);
    hint.show({ kind: 'direction', directionId: 'seo' });
    await fixture.whenStable();
    expect(host.classList.contains('wl-direction-card_target')).toBe(true);
    hint.show({ kind: 'direction', directionId: 'other' });
    await fixture.whenStable();
    expect(host.classList.contains('wl-direction-card_target')).toBe(false);
  });

  it('shows the links as a row of site icons that open the link, not the direction', async () => {
    await render(
      direction({
        links: [
          { title: 'Описание', url: 'https://wiki.example.com/pages/viewpage.action?pageId=1', kind: 'confluence' },
          { title: 'MR', url: 'https://git.example.com/x/-/merge_requests/1', kind: 'mr' },
        ],
      }),
    );
    const opened = vi.fn();
    host.addEventListener('click', opened);
    host.addEventListener('keydown', opened);

    const links = Array.from(host.querySelectorAll('a.dc__link'));
    expect(links.map(link => [link.getAttribute('href'), link.getAttribute('title'), link.getAttribute('target'), link.getAttribute('rel')])).toEqual([
      ['https://wiki.example.com/pages/viewpage.action?pageId=1', 'Описание', '_blank', 'noopener'],
      ['https://git.example.com/x/-/merge_requests/1', 'MR', '_blank', 'noopener'],
    ]);
    expect(links.map(link => link.querySelector('img.fv__img')?.getAttribute('src'))).toEqual([
      '/api/favicon?url=https%3A%2F%2Fwiki.example.com%2Fpages%2Fviewpage.action%3FpageId%3D1',
      '/api/favicon?url=https%3A%2F%2Fgit.example.com%2Fx%2F-%2Fmerge_requests%2F1',
    ]);
    expect(links.map(link => link.textContent?.trim())).toEqual(['📄', '🔀']);

    links[0].addEventListener('click', event => event.preventDefault());
    links[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    links[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(opened).not.toHaveBeenCalled();
  });

  it('has no icon row without links', async () => {
    await render(direction());
    expect(host.querySelector('.dc__links')).toBeNull();
  });

  it('is a button that reports opened on click and Enter', async () => {
    await render(direction());
    const opened = vi.fn();
    fixture.componentInstance.opened.subscribe(opened);
    expect(host.getAttribute('tabindex')).toBe('0');
    expect(host.getAttribute('role')).toBe('button');

    host.click();
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(opened).toHaveBeenCalledTimes(2);
  });

  it('shows each ticket key as its own element', async () => {
    await render(direction({ tickets: [{ key: 'APP-1', platform: 'App', url: 'https://jr.test/APP-1' }, { key: 'WEB-2', platform: 'Web', url: 'https://jr.test/WEB-2' }] }));
    expect(Array.from(host.querySelectorAll('.dc__meta .dc__key')).map(key => key.textContent)).toEqual(['APP-1', 'WEB-2']);
    expect(host.querySelector('.dc__meta')?.textContent?.replace(/\s/g, '')).toBe('APP-1WEB-2');
  });

  it('shows the running agent with its start time', async () => {
    fixture = TestBed.createComponent(DirectionCard);
    fixture.componentRef.setInput('direction', direction());
    fixture.componentRef.setInput('run', { id: 'r', template: 'execute', directionId: 'seo', branch: 'dev', title: 'x', startedAt: new Date().toISOString() });
    host = fixture.nativeElement;
    await fixture.whenStable();
    expect(host.querySelector('.dc__agent')?.textContent?.trim()).toMatch(/^✦ агент работает · с \d{2}:\d{2}$/);
  });
});
