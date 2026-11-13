import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { EMPTY_STATE } from '@worklog/model';
import { LiveUpdates } from './live-updates';

const STATE_REQUEST = { method: 'GET', url: '/api/state' };
const JIRA_REQUEST = { method: 'GET', url: '/api/jira' };
const PROFILE_REQUEST = { method: 'GET', url: '/api/profile' };
const JIRA_OK = { state: 'ok', message: null, checkedAt: null, polling: false };
const UPDATE_REQUEST = { method: 'GET', url: '/api/update' };
const UPDATE_NONE = { check: 'none', version: null, run: null };

class FakeEventSource extends EventTarget {
  static readonly created: FakeEventSource[] = [];
  static readonly CLOSED = 2;
  readonly url: string;
  readyState = 0;
  closed = false;

  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.created.push(this);
  }

  emit(type: 'open' | 'error' | 'change'): void {
    this.dispatchEvent(new Event(type));
  }

  close(): void {
    this.closed = true;
  }
}

describe('LiveUpdates', () => {
  let live: LiveUpdates;
  let http: HttpTestingController;

  beforeEach(() => {
    FakeEventSource.created.length = 0;
    vi.stubGlobal('EventSource', FakeEventSource);
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    live = TestBed.inject(LiveUpdates);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    try {
      http.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  it('reports a dropped stream and reloads the state once it reconnects', () => {
    live.start();
    const [source] = FakeEventSource.created;
    expect(source.url).toBe('/api/live');
    expect(live.connected()).toBe(true);

    source.emit('error');
    expect(live.connected()).toBe(false);
    expect(http.match(STATE_REQUEST)).toEqual([]);

    source.emit('open');
    expect(live.connected()).toBe(true);
    http.expectOne(STATE_REQUEST).flush(EMPTY_STATE);
    http.expectOne(JIRA_REQUEST).flush(JIRA_OK);
    http.expectOne(UPDATE_REQUEST).flush(UPDATE_NONE);
    http.expectOne(PROFILE_REQUEST).flush({ profile: null });
  });

  it('a reconnect reloads the profile, a change does not', () => {
    live.start();
    const [source] = FakeEventSource.created;
    source.emit('change');
    http.expectOne(STATE_REQUEST).flush(EMPTY_STATE);
    http.expectOne(JIRA_REQUEST).flush(JIRA_OK);
    http.expectOne(UPDATE_REQUEST).flush(UPDATE_NONE);
    expect(http.match(PROFILE_REQUEST)).toEqual([]);

    source.emit('open');
    http.expectOne(STATE_REQUEST).flush(EMPTY_STATE);
    http.expectOne(JIRA_REQUEST).flush(JIRA_OK);
    http.expectOne(UPDATE_REQUEST).flush(UPDATE_NONE);
    http.expectOne(PROFILE_REQUEST).flush({ profile: null });
  });

  it('a change reloads the state, the Jira health and the update status', () => {
    live.start();
    FakeEventSource.created[0].emit('change');
    http.expectOne(STATE_REQUEST).flush(EMPTY_STATE);
    http.expectOne(JIRA_REQUEST).flush(JIRA_OK);
    http.expectOne(UPDATE_REQUEST).flush(UPDATE_NONE);
  });

  it('a stream the browser gave up on is replaced after 3 s', () => {
    vi.useFakeTimers();
    live.start();
    live.start();
    const [first] = FakeEventSource.created;
    expect(FakeEventSource.created.length).toBe(1);

    first.readyState = FakeEventSource.CLOSED;
    first.emit('error');
    expect(first.closed).toBe(true);
    expect(live.connected()).toBe(false);
    vi.advanceTimersByTime(2_999);
    expect(FakeEventSource.created.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.created.length).toBe(2);

    FakeEventSource.created[1].emit('open');
    expect(live.connected()).toBe(true);
    http.expectOne(STATE_REQUEST).flush(EMPTY_STATE);
    http.expectOne(JIRA_REQUEST).flush(JIRA_OK);
    http.expectOne(UPDATE_REQUEST).flush(UPDATE_NONE);
    http.expectOne(PROFILE_REQUEST).flush({ profile: null });
  });

  it('a stream the browser still retries is left alone', () => {
    vi.useFakeTimers();
    live.start();
    const [source] = FakeEventSource.created;
    source.emit('error');
    vi.advanceTimersByTime(10_000);
    expect(source.closed).toBe(false);
    expect(FakeEventSource.created.length).toBe(1);
  });
});
