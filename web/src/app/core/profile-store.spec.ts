import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { TEST_PROFILE } from '@worklog/test-profile';
import { ProfileStore } from './profile-store';

describe('ProfileStore', () => {
  let profiles: ProfileStore;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    profiles = TestBed.inject(ProfileStore);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    try {
      http.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  it('load keeps the profile from the server', async () => {
    const loading = profiles.load();
    http.expectOne({ method: 'GET', url: '/api/profile' }).flush({ profile: TEST_PROFILE });
    await loading;
    expect(profiles.profile()).toEqual(TEST_PROFILE);
  });

  it('load leaves null when the request fails', async () => {
    const loading = profiles.load();
    http.expectOne({ method: 'GET', url: '/api/profile' }).flush('down', { status: 502, statusText: 'Bad Gateway' });
    await loading;
    expect(profiles.profile()).toBeNull();
  });
});
