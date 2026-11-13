import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Profile, Ticket } from './model.ts';
import { detectLinkKind, envCopyText, envPlatforms, envSegments, envUrl, jiraTone, mergeRequestNumber, mergeRequestUrl, parseProfile, profileQuickLinks, ProfileError, storybookLinks, ticketFromKey, ticketKeyExamples } from './model.ts';
import { TEST_PROFILE } from './test-profile.ts';

function profileWith(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...structuredClone(TEST_PROFILE), ...patch };
}

function failsWith(raw: unknown, fragment: string): void {
  assert.throws(
    () => parseProfile(raw),
    (error: unknown) => error instanceof ProfileError && error.message.includes(fragment),
  );
}

test('parseProfile accepts the test profile', () => {
  assert.deepEqual(parseProfile(structuredClone(TEST_PROFILE)), TEST_PROFILE);
});

test('parseProfile accepts a profile with nothing but projects and segments', () => {
  assert.deepEqual(parseProfile({ version: 1, projects: [], segments: [] }), { version: 1, projects: [], segments: [] });
});

test('parseProfile names the field that is wrong', () => {
  failsWith(profileWith({ jira: { ...TEST_PROFILE.jira, url: 5 } }), 'jira.url');
});

test('parseProfile rejects a stage Worklog does not have', () => {
  failsWith(profileWith({ jira: { ...TEST_PROFILE.jira, stages: { 'in qa': 'qa' } } }), 'in qa');
});

test('parseProfile asks to update Worklog for a newer version', () => {
  failsWith(profileWith({ version: 2 }), 'обнови worklog');
});

test('parseProfile asks to update the profile for an older version', () => {
  failsWith(profileWith({ version: 0 }), 'обнови профиль');
});

test('parseProfile rejects a template without {b}', () => {
  const env = structuredClone(TEST_PROFILE.env);
  failsWith(profileWith({ env: { ...env, stand: { replacements: [], templates: { App: { EU: 'https://x.example.com' } } } } }), 'env.stand.templates["App"]["EU"]');
});

test('parseProfile lowers stage names and drops the trailing slash of the Jira url', () => {
  const parsed = parseProfile(profileWith({ jira: { url: 'https://jira.example.com/', clientCert: false, stages: { 'In QA': 'testing' } } }));
  assert.deepEqual(parsed.jira, { url: 'https://jira.example.com', clientCert: false, stages: { 'in qa': 'testing' } });
});

test('ticketFromKey takes the platform and link from the profile', () => {
  assert.deepEqual(ticketFromKey('APP-1', TEST_PROFILE), { key: 'APP-1', platform: 'App', url: 'https://jira.example.com/browse/APP-1' });
});

test('ticketFromKey without a profile has no platform and no link', () => {
  assert.deepEqual(ticketFromKey('APP-1', null), { key: 'APP-1', platform: 'other', url: '' });
});

test('ticketFromKey keeps other projects of the same Jira as other', () => {
  assert.deepEqual(ticketFromKey('OPS-5', TEST_PROFILE), { key: 'OPS-5', platform: 'other', url: 'https://jira.example.com/browse/OPS-5' });
});

test('ticketKeyExamples follows the profile', () => {
  assert.deepEqual(ticketKeyExamples(TEST_PROFILE), ['APP-1234', 'WEB-1234']);
  assert.deepEqual(ticketKeyExamples(null), ['ABC-1234']);
});

function segmented(key: string, segments: string[]): Ticket {
  return { ...ticketFromKey(key, TEST_PROFILE), jira: { status: 'Open', segments, at: '2026-11-09T09:00:00.000Z' } };
}

const WITHOUT_ENV: Profile = { ...TEST_PROFILE, env: undefined };
delete WITHOUT_ENV.env;

test('envUrl fills the profile template with the replaced branch', () => {
  assert.equal(envUrl('App', 'stand', 'EU', 'feature/APP-1_WEB-2', TEST_PROFILE), 'https://feature-APP-1-WEB-2.app.eu.example.com');
  assert.equal(envUrl('App', 'build', 'US', 'feature/APP-1 x', TEST_PROFILE), 'https://ci.example.com/job/App-US/job/feature%252FAPP-1%20x');
});

test('envUrl is null without a template', () => {
  assert.equal(envUrl('Web', 'build', 'EU', 'feature/WEB-2', TEST_PROFILE), null);
  assert.equal(envUrl('App', 'stand', 'EU', 'feature/APP-1', null), null);
});

test('envPlatforms skips a project without templates', () => {
  const tickets = [ticketFromKey('WEB-2', TEST_PROFILE), ticketFromKey('APP-1', TEST_PROFILE)];
  assert.deepEqual(envPlatforms(tickets, TEST_PROFILE), ['App', 'Web']);
  assert.deepEqual(envPlatforms(tickets, WITHOUT_ENV), []);
  assert.deepEqual(envPlatforms(tickets, null), []);
});

test('envSegments ignores a Jira segment outside the profile', () => {
  assert.deepEqual(envSegments([segmented('APP-1', ['EU', 'ZZ'])], 'App', TEST_PROFILE), ['EU']);
});

test('envSegments gives all profile segments while Jira is silent', () => {
  assert.deepEqual(envSegments([ticketFromKey('APP-1', TEST_PROFILE)], 'App', TEST_PROFILE), ['EU', 'US']);
});

test('envCopyText skips a row without templates', () => {
  assert.equal(envCopyText('Web', ['EU'], 'feature/WEB-2', TEST_PROFILE), 'Тестовые стенды Web:\n\nhttps://feature-WEB-2.web.eu.example.com');
  assert.equal(
    envCopyText('App', ['EU'], 'feature/APP-1', TEST_PROFILE),
    'Тестовые стенды App:\n\nhttps://feature-APP-1.app.eu.example.com\n\nСборки App:\n\nhttps://ci.example.com/job/App/job/feature%252FAPP-1',
  );
});

test('storybookLinks is empty without storybook in the profile', () => {
  assert.deepEqual(storybookLinks('feature/APP-1', TEST_PROFILE), [{ title: 'Storybook', url: 'https://feature-APP-1.storybook.example.com' }]);
  assert.deepEqual(storybookLinks('feature/APP-1', WITHOUT_ENV), []);
});

test('mergeRequestUrl is null without GitLab in the profile', () => {
  assert.equal(mergeRequestUrl(7, TEST_PROFILE), 'https://git.example.com/team/app/-/merge_requests/7');
  assert.equal(mergeRequestUrl(7, null), null);
});

test('detectLinkKind takes confluence and jenkins hosts from the profile', () => {
  assert.equal(detectLinkKind('https://wiki.example.com/x', TEST_PROFILE), 'confluence');
  assert.equal(detectLinkKind('https://ci.example.com/job/x', TEST_PROFILE), 'jenkins');
  assert.equal(detectLinkKind('https://wiki.example.com/x', null), 'other');
  assert.equal(detectLinkKind('https://ci.example.com/job/x', null), 'other');
  assert.equal(detectLinkKind('https://www.figma.com/design/x', TEST_PROFILE), 'figma');
  assert.equal(detectLinkKind('https://www.figma.com/design/x', null), 'figma');
});

test('jiraTone colours statuses from the profile, whatever the case', () => {
  assert.equal(jiraTone(' In QA ', TEST_PROFILE), 'orange');
  assert.equal(jiraTone('CLOSED', TEST_PROFILE), 'green');
  assert.equal(jiraTone('Open', TEST_PROFILE), 'gray');
  assert.equal(jiraTone('In QA', null), 'gray');
});

test('parseProfile rejects a tone Worklog does not have', () => {
  failsWith(profileWith({ jira: { ...TEST_PROFILE.jira, tones: { 'in qa': 'pink' } } }), 'tones');
});

test('parseProfile adds the trailing slash to the merge requests url', () => {
  const parsed = parseProfile(profileWith({ gitlab: { sshHost: 'git.example.com', mergeRequestsUrl: 'https://git.example.com/team/app/-/merge_requests' } }));
  assert.equal(parsed.gitlab?.mergeRequestsUrl, 'https://git.example.com/team/app/-/merge_requests/');
  assert.equal(mergeRequestNumber(mergeRequestUrl(3015, parsed) ?? ''), 3015);
});

test('profileQuickLinks fills in the GitLab login', () => {
  assert.deepEqual(profileQuickLinks(TEST_PROFILE, 'jdoe'), {
    groups: [{ title: 'Каждый день', links: [{ title: 'Мои MR', url: 'https://git.example.com/jdoe', description: 'Мои мерж реквесты' }] }],
    skipped: [],
  });
});

test('profileQuickLinks skips links that need a login it does not have', () => {
  const profile: Profile = { ...TEST_PROFILE, links: [{ title: 'Каждый день', links: [{ title: 'Почта', url: 'https://mail.example.com' }, { title: 'Мои MR', url: 'https://git.example.com/{gitlabUser}' }] }] };
  assert.deepEqual(profileQuickLinks(profile, undefined), { groups: [{ title: 'Каждый день', links: [{ title: 'Почта', url: 'https://mail.example.com' }] }], skipped: ['Мои MR'] });
  assert.deepEqual(profileQuickLinks(TEST_PROFILE, ''), { groups: [], skipped: ['Мои MR'] });
  assert.deepEqual(profileQuickLinks(null, 'jdoe'), { groups: [], skipped: [] });
});

test('parseProfile normalises the case of project prefixes and link hosts', () => {
  const profile = parseProfile({ ...TEST_PROFILE, projects: [{ prefix: 'app-', label: 'App' }], linkHosts: { confluence: ['Wiki.Example.com'], jenkinsPrefixes: ['CI.'] } });
  assert.equal(ticketFromKey('APP-1', profile).platform, 'App');
  assert.deepEqual(profile.linkHosts, { confluence: ['wiki.example.com'], jenkinsPrefixes: ['ci.'] });
});
