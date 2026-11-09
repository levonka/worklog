import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { Favicon } from './favicon';

@Component({
  imports: [Favicon],
  template: `<wl-favicon [url]="url()"><span class="fallback">Ж</span></wl-favicon>`,
})
class Host {
  readonly url = signal('https://jira.example.com/browse/APP-1?a=1&b=2');
}

describe('Favicon', () => {
  let fixture: ComponentFixture<Host>;
  let host: HTMLElement;

  beforeEach(async () => {
    fixture = TestBed.createComponent(Host);
    host = fixture.nativeElement;
    await fixture.whenStable();
  });

  afterEach(() => TestBed.resetTestingModule());

  function image(): HTMLImageElement | null {
    return host.querySelector('img');
  }

  function fallback(): HTMLElement | null {
    return host.querySelector('.fallback');
  }

  it("asks Worklog's server for the link's icon and keeps the fallback until it loads", async () => {
    expect(image()?.getAttribute('src')).toBe('/api/favicon?url=https%3A%2F%2Fjira.example.com%2Fbrowse%2FAPP-1%3Fa%3D1%26b%3D2');
    expect(image()?.hidden).toBe(true);
    expect(fallback()).not.toBeNull();

    image()?.dispatchEvent(new Event('load'));
    await fixture.whenStable();

    expect(image()?.hidden).toBe(false);
    expect(fallback()).toBeNull();
  });

  it('shows the fallback when there is no icon', async () => {
    image()?.dispatchEvent(new Event('error'));
    await fixture.whenStable();

    expect(image()).toBeNull();
    expect(fallback()).not.toBeNull();
  });

  it('tries again for another link', async () => {
    image()?.dispatchEvent(new Event('error'));
    await fixture.whenStable();

    fixture.componentInstance.url.set('https://git.example.com/');
    await fixture.whenStable();

    expect(image()?.getAttribute('src')).toBe('/api/favicon?url=https%3A%2F%2Fgit.example.com%2F');
    expect(fallback()).not.toBeNull();
  });
});
