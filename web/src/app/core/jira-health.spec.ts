import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { JiraHealth } from '@worklog/model';
import { JiraHealthStore } from './jira-health';

const OK: JiraHealth = { state: 'ok', message: null, checkedAt: '2026-11-06T06:42:00.000Z', polling: false };
const ERROR: JiraHealth = { state: 'error', message: 'нет связи', checkedAt: '2026-11-06T06:42:00.000Z', polling: false };

describe('JiraHealthStore', () => {
  let jira: JiraHealthStore;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    jira = TestBed.inject(JiraHealthStore);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    try {
      http.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  it('load keeps what GET /api/jira answers, and the last answer when it fails', async () => {
    expect(jira.health()).toBeNull();
    const first = jira.load();
    http.expectOne({ method: 'GET', url: '/api/jira' }).flush(OK);
    await first;
    expect(jira.health()).toEqual(OK);

    const second = jira.load();
    http.expectOne({ method: 'GET', url: '/api/jira' }).flush('down', { status: 502, statusText: 'Bad Gateway' });
    await second;
    expect(jira.health()).toEqual(OK);
  });

  it('refresh posts and keeps the answer; busy until it comes', async () => {
    const done = jira.refresh();
    expect(jira.refreshing()).toBe(true);
    http.expectOne({ method: 'POST', url: '/api/jira/refresh' }).flush(ERROR);
    await done;
    expect(jira.refreshing()).toBe(false);
    expect(jira.health()).toEqual(ERROR);
  });
});
