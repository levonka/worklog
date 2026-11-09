import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { JiraAuth, JiraConfig, JiraFetch, JiraRequest } from './jira.ts';
import { createJiraFetch, JiraError, jiraConfig, jiraUser, keychainPassword, parseSearch, searchUrl } from './jira.ts';
import { TEST_PROFILE } from '../shared/test-profile.ts';

const FIELD = 'customfield_10001';
const TOKEN = 'secret-token-value';

async function tempConfig(t: TestContext, files: { p12?: boolean; clientCert?: boolean } = {}): Promise<JiraConfig> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-jira-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config: JiraConfig = {
    url: 'https://jr.example.test',
    clientCert: files.clientCert ?? true,
    p12Path: path.join(dir, 'jira.p12'),
    keychainService: 'worklog-test',
    tokenService: 'worklog-test-token',
    caPath: path.join(dir, 'jira-ca.crt'),
    segmentField: FIELD,
  };
  if (files.p12 ?? true) await writeFile(config.p12Path, 'not a real certificate');
  return config;
}

/** a keychain with the given items: the certificate password and the token by default */
function keychain(items: Record<string, string> = { 'worklog-test': 'pass', 'worklog-test-token': TOKEN }) {
  return async (service: string): Promise<string | null> => (Object.hasOwn(items, service) ? items[service] : null);
}

const password = keychain();

function answering(answers: (keys: string[]) => { status: number; body: string; user?: string } | Error): { request: JiraRequest; calls: { url: string; auth: JiraAuth }[] } {
  const calls: { url: string; auth: JiraAuth }[] = [];
  const request: JiraRequest = async (url, auth) => {
    calls.push({ url, auth });
    const keys = /key in \(([^)]*)\)/.exec(new URL(url).searchParams.get('jql') ?? '')?.[1].split(',') ?? [];
    const answer = answers(keys);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { request, calls };
}

function searchBody(keys: readonly string[]): string {
  return JSON.stringify({ issues: keys.map(key => ({ key, fields: { status: { name: 'Open' }, [FIELD]: [{ value: 'EU' }] } })) });
}

async function fetchOf(config: JiraConfig, request: JiraRequest, readPassword = password): Promise<JiraFetch> {
  const fetch = await createJiraFetch(config, readPassword, request);
  if (typeof fetch === 'string') throw new Error(`not configured: ${fetch}`);
  return fetch;
}

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

test('searchUrl asks for status and Segment of the keys', () => {
  const url = new URL(searchUrl('https://jira.example.com', ['APP-1', 'WEB-2'], FIELD));
  assert.equal(url.origin + url.pathname, 'https://jira.example.com/rest/api/2/search');
  assert.equal(url.searchParams.get('jql'), 'key in (APP-1,WEB-2)');
  assert.equal(url.searchParams.get('fields'), `status,${FIELD}`);
  assert.equal(url.searchParams.get('maxResults'), '2');
  assert.equal(url.searchParams.get('validateQuery'), 'warn');
});

test('searchUrl asks only status without a segment field', () => {
  assert.equal(new URL(searchUrl('https://jira.example.com', ['APP-1'], undefined)).searchParams.get('fields'), 'status');
});

test('parseSearch gives no segments without a segment field', () => {
  const body = { issues: [{ key: 'APP-1', fields: { status: { name: 'Open' }, [FIELD]: [{ value: 'EU' }] } }] };
  assert.deepEqual(parseSearch(body, undefined), [{ key: 'APP-1', status: 'Open', segments: [] }]);
});

test('jiraConfig takes url and segment field from the profile', () => {
  const files = { p12Path: '/p.p12', caPath: '/ca.crt', keychainService: 'worklog-jira-p12', tokenService: 'worklog-jira-token' };
  assert.ok(TEST_PROFILE.jira);
  assert.deepEqual(jiraConfig(TEST_PROFILE.jira, files), { ...files, url: 'https://jira.example.com', clientCert: true, segmentField: 'customfield_10001' });
  assert.deepEqual(jiraConfig({ url: 'https://jira.example.com', clientCert: false, stages: {} }, files), { ...files, url: 'https://jira.example.com', clientCert: false });
});

test('parseSearch reads status and Segment values', () => {
  const body = {
    issues: [
      { key: 'APP-9355', fields: { status: { name: 'In CodeReview' }, [FIELD]: [{ value: 'EU' }, { value: 'ZZ' }] } },
      { key: 'WEB-1', fields: { status: { name: 'Open' }, [FIELD]: null } },
      { key: 'WEB-2', fields: { [FIELD]: [] } },
    ],
  };
  assert.deepEqual(parseSearch(body, FIELD), [
    { key: 'APP-9355', status: 'In CodeReview', segments: ['EU', 'ZZ'] },
    { key: 'WEB-1', status: 'Open', segments: [] },
  ]);
  assert.throws(() => parseSearch('nope', FIELD), JiraError);
  assert.throws(() => parseSearch({ total: 0 }, FIELD), { message: 'непонятный ответ' });
});

test('createJiraFetch explains what is missing', async t => {
  const noP12 = String(await createJiraFetch(await tempConfig(t, { p12: false }), password));
  const noToken = String(await createJiraFetch(await tempConfig(t), keychain({ 'worklog-test': 'pass' })));
  const noPassword = String(await createJiraFetch(await tempConfig(t), keychain({ 'worklog-test-token': TOKEN })));
  assert.match(noP12, /сертификат/);
  assert.equal(noToken, 'нет токена в связке ключей (worklog-test-token)');
  assert.match(noPassword, /пароля/);
  for (const text of [noP12, noToken, noPassword]) assert.equal(text.includes(TOKEN), false);
});

test('createJiraFetch needs no certificate when the profile says so', async t => {
  const config = await tempConfig(t, { p12: false, clientCert: false });
  const { request, calls } = answering(keys => ({ status: 200, body: searchBody(keys) }));
  await (await fetchOf(config, request, keychain({ 'worklog-test-token': TOKEN })))(['APP-1']);

  assert.equal(calls[0].auth.token, TOKEN);
  assert.equal(calls[0].auth.pfx, undefined);
  assert.equal(calls[0].auth.passphrase, undefined);
});

test('createJiraFetch takes the token from the keychain and sends the certificate', async t => {
  const config = await tempConfig(t);
  const { request, calls } = answering(keys => ({ status: 200, body: searchBody(keys) }));
  const issues = await (await fetchOf(config, request))(['APP-1']);

  assert.deepEqual(issues, [{ key: 'APP-1', status: 'Open', segments: ['EU'] }]);
  assert.equal(calls[0].auth.token, TOKEN);
  assert.equal(calls[0].auth.passphrase, 'pass');
  assert.equal(calls[0].auth.pfx?.toString(), 'not a real certificate');
  assert.equal(calls[0].auth.ca, undefined);
});

test('createJiraFetch adds the CA file to the default ones when it exists', async t => {
  const config = await tempConfig(t);
  await writeFile(config.caPath, 'CA TEXT');
  const { request, calls } = answering(keys => ({ status: 200, body: searchBody(keys) }));
  await (await fetchOf(config, request))(['APP-1']);

  assert.equal(calls[0].auth.ca?.at(-1), 'CA TEXT');
  assert.ok((calls[0].auth.ca?.length ?? 0) > 1);
});

test('createJiraFetch maps HTTP answers to user messages', async t => {
  const config = await tempConfig(t);
  const cases: [{ status: number; body: string } | Error, string][] = [
    [{ status: 401, body: '' }, 'истёк или неверный токен'],
    [{ status: 403, body: '' }, 'истёк или неверный токен'],
    [{ status: 400, body: '<title>400 No required SSL certificate was sent</title>' }, 'не принят сертификат'],
    [{ status: 500, body: '' }, 'ответила 500'],
    [{ status: 200, body: '<html>' }, 'непонятный ответ'],
    [withCode('getaddrinfo', 'ENOTFOUND'), 'нет связи'],
    [withCode('refused', 'ECONNREFUSED'), 'нет связи'],
    [withCode('timeout', 'ETIMEDOUT'), 'нет связи'],
    [withCode('self signed', 'SELF_SIGNED_CERT_IN_CHAIN'), 'не доверяю сертификату сервера (SELF_SIGNED_CERT_IN_CHAIN)'],
  ];
  for (const [answer, message] of cases) {
    const fetch = await fetchOf(config, answering(() => answer).request);
    await assert.rejects(fetch(['APP-1']), (error: unknown) => error instanceof JiraError && error.message === message && !error.message.includes(TOKEN), message);
  }
});

test('an anonymous answer means the token was not accepted', async t => {
  // with a wrong or expired token Jira answers 200 with no issues, as to a guest
  const config = await tempConfig(t);
  const fetch = await fetchOf(config, answering(() => ({ status: 200, body: searchBody([]), user: 'anonymous' })).request);
  await assert.rejects(fetch(['APP-1']), { message: 'истёк или неверный токен' });

  const known = await fetchOf(config, answering(keys => ({ status: 200, body: searchBody(keys), user: 'jdoe' })).request);
  assert.equal((await known(['APP-1'])).length, 1);
});

test('createJiraFetch asks in batches of 50 and joins the answers', async t => {
  const config = await tempConfig(t);
  const { request, calls } = answering(keys => ({ status: 200, body: searchBody(keys) }));
  const keys = Array.from({ length: 120 }, (_, i) => `APP-${i + 1}`);
  const issues = await (await fetchOf(config, request))(keys);

  assert.equal(calls.length, 3);
  assert.deepEqual(
    issues.map(issue => issue.key),
    keys,
  );
});

test('keychainPassword returns null for a missing item', async () => {
  assert.equal(await keychainPassword(`worklog-test-missing-${Date.now()}`), null);
});

test('jiraUser returns the login from myself', async t => {
  const config = await tempConfig(t);
  const { request, calls } = answering(() => ({ status: 200, body: '{"name":"jdoe","displayName":"J. Doe"}' }));
  assert.equal(await jiraUser(config, password, request), 'jdoe');
  assert.equal(calls[0].url, 'https://jr.example.test/rest/api/2/myself');
  assert.equal(calls[0].auth.token, TOKEN);
});

test('jiraUser tells token, certificate and network failures apart', async t => {
  const config = await tempConfig(t);
  const kindOf = async (answer: { status: number; body: string; user?: string } | Error, readPassword = password) => {
    try {
      await jiraUser(config, readPassword, answering(() => answer).request);
      return 'ok';
    } catch (error) {
      assert.ok(error instanceof JiraError);
      return error.kind;
    }
  };
  assert.equal(await kindOf({ status: 401, body: '' }), 'token');
  assert.equal(await kindOf({ status: 200, body: '{"name":"anonymous"}', user: 'anonymous' }), 'token');
  assert.equal(await kindOf({ status: 400, body: 'No required SSL certificate was sent' }), 'cert');
  assert.equal(await kindOf(withCode('timeout', 'ETIMEDOUT')), 'network');
  assert.equal(await kindOf(withCode('self signed', 'SELF_SIGNED_CERT_IN_CHAIN')), 'server-cert');
  assert.equal(await kindOf({ status: 200, body: '{}' }, keychain({ 'worklog-test': 'pass' })), 'token');
  assert.equal(await kindOf({ status: 200, body: '{}' }, keychain({ 'worklog-test-token': TOKEN })), 'cert');
});
