import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Tooltip, tooltipPlace } from './tooltip';

@Component({
  imports: [Tooltip],
  template: `@if (shown()) {
    <a class="anchor" href="https://example.com" [wlTooltip]="text()">x</a>
  }`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class Host {
  readonly text = signal('Макет');
  readonly shown = signal(true);
}

describe('Tooltip', () => {
  let host: Host;
  let anchor: HTMLElement;

  async function render(): Promise<void> {
    const fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    await fixture.whenStable();
    anchor = fixture.nativeElement.querySelector('.anchor');
  }

  const tips = (): string[] => Array.from(document.body.querySelectorAll('.wl-tooltip')).map(tip => tip.textContent ?? '');

  afterEach(() => {
    TestBed.resetTestingModule();
    document.body.querySelectorAll('.wl-tooltip').forEach(tip => tip.remove());
  });

  it('shows the text over the page while the pointer is on the element', async () => {
    await render();
    anchor.dispatchEvent(new MouseEvent('mouseenter'));
    expect(tips()).toEqual(['Макет']);
    expect(document.body.querySelector('.wl-tooltip')?.getAttribute('role')).toBe('tooltip');

    anchor.dispatchEvent(new MouseEvent('mouseleave'));
    expect(tips()).toEqual([]);
  });

  it('hides on press and on scroll', async () => {
    await render();
    anchor.dispatchEvent(new MouseEvent('mouseenter'));
    anchor.dispatchEvent(new Event('pointerdown'));
    expect(tips()).toEqual([]);

    anchor.dispatchEvent(new MouseEvent('mouseenter'));
    anchor.dispatchEvent(new Event('wheel'));
    expect(tips()).toEqual([]);
  });

  it('shows one label however many times the pointer enters', async () => {
    await render();
    anchor.dispatchEvent(new MouseEvent('mouseenter'));
    anchor.dispatchEvent(new MouseEvent('mouseenter'));
    expect(tips()).toEqual(['Макет']);
  });

  it('shows nothing for an empty text', async () => {
    await render();
    host.text.set('');
    TestBed.tick();
    anchor.dispatchEvent(new MouseEvent('mouseenter'));
    expect(tips()).toEqual([]);
  });

  it('leaves no label behind when the element goes away', async () => {
    await render();
    anchor.dispatchEvent(new MouseEvent('mouseenter'));
    host.shown.set(false);
    TestBed.tick();
    expect(tips()).toEqual([]);
  });
});

describe('tooltipPlace', () => {
  const view = { width: 800, height: 600 };
  const tip = { width: 100, height: 20 };

  it('puts the label above the element, centred on it', () => {
    expect(tooltipPlace({ left: 300, top: 200, width: 20, height: 20 }, tip, view)).toEqual({ left: 260, top: 174 });
  });

  it('puts the label below when there is no room above', () => {
    expect(tooltipPlace({ left: 300, top: 10, width: 20, height: 20 }, tip, view)).toEqual({ left: 260, top: 36 });
  });

  it('keeps the label inside the window', () => {
    expect(tooltipPlace({ left: 0, top: 200, width: 20, height: 20 }, tip, view).left).toBe(4);
    expect(tooltipPlace({ left: 790, top: 200, width: 10, height: 20 }, tip, view).left).toBe(696);
  });
});
