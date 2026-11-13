import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import type { UpdateCheck, UpdateRun, UpdateStatus } from '@worklog/model';
import { UpdateButton } from './update-button';
import { UpdateStore } from './update-store';

const GET = { method: 'GET', url: '/api/update' };
const NOW = new Date('2026-11-13T09:00:00.000Z');

function status(check: UpdateCheck, version = 'aaa111', run: UpdateRun | null = null): UpdateStatus {
  return { check, version, run };
}

describe('UpdateButton', () => {
  let fixture: ComponentFixture<UpdateButton>;
  let http: HttpTestingController;
  let host: HTMLElement;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    TestBed.configureTestingModule({ imports: [UpdateButton], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(UpdateButton);
    host = fixture.nativeElement;
    await render();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    try {
      http.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  // under fake timers: the answers settle, then the view follows
  async function render(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
  }

  async function load(answer: UpdateStatus): Promise<void> {
    const loading = TestBed.inject(UpdateStore).load();
    http.expectOne(GET).flush(answer);
    await loading;
    await render();
  }

  function shown(): HTMLButtonElement | null {
    return host.querySelector('.ub__btn');
  }

  it('shows nothing without a new version', async () => {
    expect(shown()).toBeNull();
    await load(status('none'));
    expect(shown()).toBeNull();
  });

  it('Обновить Worklog starts the update and turns into a timer', async () => {
    await load(status('available'));
    const button = shown();
    expect(button?.textContent?.trim()).toBe('Обновить Worklog');
    expect(button?.disabled).toBe(false);

    button?.click();
    await render();
    expect(shown()?.textContent?.trim()).toBe('Обновляю… 0:00');
    expect(shown()?.disabled).toBe(true);

    const run: UpdateRun = { phase: 'running', startedAt: '2026-11-13T08:59:18.000Z' };
    http.expectOne({ method: 'POST', url: '/api/update' }).flush({ run }, { status: 202, statusText: 'Accepted' });
    await render();
    http.expectOne(GET).flush(status('available', 'aaa111', { ...run, pid: 7 }));
    await render();
    expect(shown()?.textContent?.trim()).toBe('Обновляю… 0:42');

    await vi.advanceTimersByTimeAsync(1_000);
    fixture.detectChanges();
    expect(shown()?.textContent?.trim()).toBe('Обновляю… 0:43');
  });

  it('is muted with a hint when the clone has its own changes', async () => {
    await load(status('local-changes'));
    const button = shown();
    expect(button?.textContent?.trim()).toBe('Обновить Worklog');
    expect(button?.classList).toContain('ub__btn_muted');
    expect(button?.disabled).toBe(true);
    expect(button?.title).toBe('В папке Worklog есть свои правки — обновите её через git');
  });

  it('offers Перезагрузить while the reload waits', async () => {
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();

    await load(status('none'));
    await load(status('none', 'bbb222'));

    expect(shown()?.textContent?.trim()).toBe('Перезагрузить');
    expect(shown()?.title).toBe('Worklog обновлён — перезагрузите окно');
  });
});
