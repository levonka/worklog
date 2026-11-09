import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { TabsStore } from '../core/tabs-store';
import { TabBar } from './tab-bar';

describe('TabBar', () => {
  let fixture: ComponentFixture<TabBar>;
  let host: HTMLElement;

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({ imports: [TabBar], providers: [provideHttpClient(), provideHttpClientTesting()] });
    fixture = TestBed.createComponent(TabBar);
    fixture.componentRef.setInput('contentArea', document.createElement('div'));
    host = fixture.nativeElement;
    await fixture.whenStable();
  });

  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  function tabTitles(): string[] {
    return Array.from(host.querySelectorAll('.tb__title')).map(title => title.textContent?.trim() ?? '');
  }

  it.each(['Delete', 'Backspace'])('%s on a focused tab closes it', async key => {
    const [board] = Array.from(host.querySelectorAll<HTMLElement>('.tb__tab'));
    board.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await fixture.whenStable();

    expect(TestBed.inject(TabsStore).layout().tabs).toEqual(['todos']);
    expect(tabTitles()).toEqual(['Дела']);
  });

  it('the ✕ is for the mouse only', () => {
    const close = host.querySelector('.tb__close');
    expect(close?.getAttribute('tabindex')).toBe('-1');
    expect(close?.getAttribute('aria-hidden')).toBe('true');
  });
});
