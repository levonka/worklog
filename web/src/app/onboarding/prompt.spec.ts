import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { Prompt } from './prompt';

@Component({
  imports: [Prompt],
  template: `<wl-prompt [text]="text()" />`,
})
class Host {
  readonly text = signal('запиши в worklog по карте: бэк поправил выдачу точек, жду стенд');
}

describe('Prompt', () => {
  let fixture: ComponentFixture<Host>;
  let host: HTMLElement;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    fixture = TestBed.createComponent(Host);
    host = fixture.nativeElement;
    await fixture.whenStable();
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  function copyButton(): HTMLButtonElement {
    const button = host.querySelector<HTMLButtonElement>('.pr__copy');
    if (button === null) throw new Error('Нет кнопки копирования');
    return button;
  }

  async function click(): Promise<void> {
    copyButton().click();
    await vi.advanceTimersByTimeAsync(0);
    await fixture.whenStable();
  }

  it('copies exactly the prompt text, which can be selected', async () => {
    await click();

    expect(writeText).toHaveBeenCalledWith('запиши в worklog по карте: бэк поправил выдачу точек, жду стенд');
    expect(host.querySelector('.pr__text')?.classList).toContain('wl-selectable');
  });

  it('shows Скопировано and brings the label back after 1.5 s', async () => {
    expect(copyButton().textContent?.trim()).toBe('Скопировать');

    await click();
    expect(copyButton().textContent?.trim()).toBe('Скопировано');

    await vi.advanceTimersByTimeAsync(1500);
    await fixture.whenStable();
    expect(copyButton().textContent?.trim()).toBe('Скопировать');
  });

  it('a clipboard refusal does not throw and shows Не скопировалось', async () => {
    writeText.mockRejectedValue(new Error('NotAllowedError'));

    await click();
    expect(copyButton().textContent?.trim()).toBe('Не скопировалось');

    await vi.advanceTimersByTimeAsync(1500);
    await fixture.whenStable();
    expect(copyButton().textContent?.trim()).toBe('Скопировать');
  });
});
