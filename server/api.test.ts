import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { localDate } from '../shared/model.ts';
import type { AgentRun, Direction, Link, Note, Profile, QuickLink, QuickLinkGroup, Ticket, Todo, UpdateFacts, UpdateStatus, WorkEvent, WorklogState } from '../shared/model.ts';
import type { AgentConfig } from './agent-launch.ts';
import type { CodeConfig } from './code-files.ts';
import { createApp } from './app.ts';
import type { AppOptions } from './app.ts';
import { initDataRepo } from './data-git.ts';
import { png, writeFaviconsDb } from './favicons.fixture.ts';
import { Store } from './store.ts';
import { TEST_PROFILE } from '../shared/test-profile.ts';

const IDLE_MS = 60_000;

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function startApp(t: TestContext, opts: { staticDir?: string; code?: CodeConfig; agent?: AgentConfig; dataDir?: string; profile?: Profile | null } = {}): Promise<string> {
  const dataDir = opts.dataDir ?? (await tempDir(t, 'worklog-api-data-'));
  const staticDir = opts.staticDir ?? path.join(await tempDir(t, 'worklog-api-static-'), 'missing');
  const app = await createApp({ dataDir, port: 0, staticDir, idleMs: IDLE_MS, code: opts.code, agent: opts.agent, profile: opts.profile === undefined ? TEST_PROFILE : opts.profile });
  t.after(() => app.close());
  return app.url;
}

async function call(base: string, method: string, route: string, body?: unknown): Promise<Response> {
  return fetch(base + route, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text());
}

async function createDirection(base: string, body: unknown): Promise<Direction> {
  const response = await call(base, 'POST', '/api/directions', body);
  assert.equal(response.status, 201);
  return json<Direction>(response);
}

test('health reports ok with no clients', async t => {
  const base = await startApp(t);
  const response = await call(base, 'GET', '/api/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { ok: true, clients: 0 });
});

test('created direction appears in state', async t => {
  const base = await startApp(t);
  const created = await createDirection(base, { title: 'Сео', tickets: ['app-9355'] });
  assert.equal(created.title, 'Сео');
  assert.equal(created.status, 'in_progress');
  assert.deepEqual(created.tickets.map(ticket => ticket.key), ['APP-9355']);

  const state = await json<WorklogState>(await call(base, 'GET', '/api/state'));
  assert.deepEqual(state.directions.map(d => d.id), [created.id]);
});

test('status change keeps waitingFor and records a system event', async t => {
  const base = await startApp(t);
  const created = await createDirection(base, { title: 'Сео' });
  const response = await call(base, 'POST', `/api/directions/${created.id}/status`, { status: 'waiting', waitingFor: 'девопсы' });
  assert.equal(response.status, 200);
  const updated = await json<Direction>(response);
  assert.equal(updated.status, 'waiting');
  assert.equal(updated.waitingFor, 'девопсы');
  assert.equal(updated.events.at(-1)?.text, 'Статус: Жду · девопсы');
});

test('unmark puts a waiting direction back to its stage', async t => {
  const base = await startApp(t);
  const created = await createDirection(base, { title: 'Сео', status: 'waiting', waitingFor: 'девопсы' });
  const response = await call(base, 'POST', `/api/directions/${created.id}/unmark`);
  assert.equal(response.status, 200);
  const updated = await json<Direction>(response);
  assert.equal(updated.status, 'in_progress');
  assert.equal(updated.waitingFor, undefined);
  assert.equal(updated.events.at(-1)?.text, 'Больше не жду: девопсы');
});

test('status refuses a stage of a Jira-led direction with 400', async t => {
  const dataDir = await tempDir(t, 'worklog-api-data-');
  const store = new Store(dataDir, { profile: TEST_PROFILE });
  const created = await store.createDirection({ title: 'Сео', ticketKeys: ['APP-1'] });
  await store.applyJira([{ key: 'APP-1', status: 'In Review', segments: [] }], '2026-11-06T09:00:00.000Z');
  const base = await startApp(t, { dataDir });

  const response = await call(base, 'POST', `/api/directions/${created.id}/status`, { status: 'testing' });
  assert.equal(response.status, 400);
  assert.match((await json<{ error: string }>(response)).error, /берётся из Jira \(сейчас: В мерж реквесте\)/);
});

test('empty title is rejected with 400', async t => {
  const base = await startApp(t);
  const response = await call(base, 'POST', '/api/directions', { title: '' });
  assert.equal(response.status, 400);
  assert.equal(typeof (await json<{ error: string }>(response)).error, 'string');
});

test('wrong field types and unknown status are rejected with 400', async t => {
  const base = await startApp(t);
  assert.equal((await call(base, 'POST', '/api/directions', { title: 5 })).status, 400);
  assert.equal((await call(base, 'POST', '/api/directions', { title: 'x', status: 'nope' })).status, 400);
  assert.equal((await call(base, 'POST', '/api/directions', { title: 'x', tickets: 'APP-1' })).status, 400);
  const created = await createDirection(base, { title: 'x' });
  assert.equal((await call(base, 'POST', `/api/directions/${created.id}/status`, { status: 'nope' })).status, 400);
});

test('invalid json body is rejected with 400', async t => {
  const base = await startApp(t);
  const response = await fetch(`${base}/api/directions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{oops',
  });
  assert.equal(response.status, 400);
});

test('body without application/json content type is rejected with 415 and changes nothing', async t => {
  const base = await startApp(t);
  const plain = await fetch(`${base}/api/directions`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ title: 'evil' }),
  });
  assert.equal(plain.status, 415);
  const noType = await fetch(`${base}/api/directions`, { method: 'POST', body: JSON.stringify({ title: 'evil' }) });
  assert.equal(noType.status, 415);
  const state = await json<WorklogState>(await call(base, 'GET', '/api/state'));
  assert.equal(state.directions.length, 0);
  const charset = await fetch(`${base}/api/directions`, {
    method: 'POST',
    headers: { 'content-type': 'Application/JSON; charset=utf-8' },
    body: JSON.stringify({ title: 'ok' }),
  });
  assert.equal(charset.status, 201);
});

function requestWithHost(base: string, host: string | undefined, route: string): Promise<number> {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const headers = host === undefined ? {} : { host };
    const req = httpRequest({ host: '127.0.0.1', port, path: route, headers }, res => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

test('requests with a foreign Host header are rejected with 403', async t => {
  const base = await startApp(t);
  const { port } = new URL(base);
  assert.equal(await requestWithHost(base, `evil.example:${port}`, '/api/state'), 403);
  assert.equal(await requestWithHost(base, 'localhost', '/api/state'), 403);
  assert.equal(await requestWithHost(base, `localhost:${port}`, '/api/state'), 200);
  assert.equal(await requestWithHost(base, `127.0.0.1:${port}`, '/api/state'), 200);
});

function postWithOrigin(base: string, origin: string | undefined, route: string): Promise<number> {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const headers = origin === undefined ? {} : { origin };
    const req = httpRequest({ host: '127.0.0.1', port, path: route, method: 'POST', headers }, res => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

test('a write without a body from a foreign page is rejected with 403', async t => {
  const base = await startApp(t);
  const { port } = new URL(base);
  assert.equal(await postWithOrigin(base, 'https://evil.example', '/api/undo'), 403);
  assert.equal(await postWithOrigin(base, 'null', '/api/undo'), 403);
  assert.equal(await postWithOrigin(base, `http://127.0.0.1:${port}`, '/api/undo'), 200);
  assert.equal(await postWithOrigin(base, `http://localhost:${port}`, '/api/undo'), 200);
  // the CLI and curl send no Origin
  assert.equal(await postWithOrigin(base, undefined, '/api/undo'), 200);
});

test('unknown direction id gives 404', async t => {
  const base = await startApp(t);
  const response = await call(base, 'POST', '/api/directions/nope/events', { text: 'привет' });
  assert.equal(response.status, 404);
  assert.equal(typeof (await json<{ error: string }>(response)).error, 'string');
  assert.equal((await call(base, 'DELETE', '/api/directions/nope')).status, 404);
});

test('unknown api route gives 404 json', async t => {
  const base = await startApp(t);
  const response = await call(base, 'GET', '/api/nothing');
  assert.equal(response.status, 404);
  assert.equal(typeof (await json<{ error: string }>(response)).error, 'string');
});

test('direction patch renames and clears waitingFor', async t => {
  const base = await startApp(t);
  const created = await createDirection(base, { title: 'Сео', status: 'waiting', waitingFor: 'девопсы' });
  const renamed = await json<Direction>(await call(base, 'PATCH', `/api/directions/${created.id}`, { title: 'SEO' }));
  assert.equal(renamed.title, 'SEO');
  assert.equal(renamed.waitingFor, 'девопсы');
  const cleared = await json<Direction>(await call(base, 'PATCH', `/api/directions/${created.id}`, { waitingFor: null }));
  assert.equal(cleared.waitingFor, undefined);
});

test('empty direction patch returns the direction unchanged, 404 for an unknown one', async t => {
  const base = await startApp(t);
  const created = await createDirection(base, { title: 'Сео' });
  const response = await call(base, 'PATCH', `/api/directions/${created.id}`, {});
  assert.equal(response.status, 200);
  assert.deepEqual(await json<Direction>(response), created);
  assert.equal((await call(base, 'PATCH', '/api/directions/nope', {})).status, 404);
});

test('todo patch with only done marks it done; directionId null unlinks it', async t => {
  const base = await startApp(t);
  const direction = await createDirection(base, { title: 'Сео' });
  const todo = await json<Todo>(await call(base, 'POST', '/api/todos', { text: 'Дело', directionId: direction.id }));
  const done = await json<Todo>(await call(base, 'PATCH', `/api/todos/${todo.id}`, { done: true }));
  assert.equal(done.done, true);
  assert.equal(done.text, 'Дело');
  const unlinked = await json<Todo>(await call(base, 'PATCH', `/api/todos/${todo.id}`, { directionId: null }));
  assert.equal('directionId' in unlinked, false);
  const state = await json<WorklogState>(await call(base, 'GET', '/api/state'));
  assert.deepEqual(state.directions[0].events, []);
});

test('todo link and time are set on create and cleared with null', async t => {
  const base = await startApp(t);
  const todo = await json<Todo>(await call(base, 'POST', '/api/todos', { text: 'Звонок', url: 'meet.example.com/f416', time: '12:00' }));
  assert.deepEqual([todo.url, todo.time], ['https://meet.example.com/f416', '12:00']);
  const cleared = await json<Todo>(await call(base, 'PATCH', `/api/todos/${todo.id}`, { url: null, time: null }));
  assert.equal('url' in cleared || 'time' in cleared, false);
  assert.equal((await call(base, 'PATCH', `/api/todos/${todo.id}`, { time: '7' })).status, 400);
});

test('a path with a broken percent-encoding gives 400', async t => {
  const base = await startApp(t);
  assert.equal((await call(base, 'DELETE', '/api/directions/%E0%A4%A')).status, 400);
});

test('a broken data file gives 500 with the file named', async t => {
  const dataDir = await tempDir(t, 'worklog-api-data-');
  await mkdir(path.join(dataDir, 'directions'));
  await writeFile(path.join(dataDir, 'directions', 'abc.json'), '{');
  const app = await createApp({ dataDir, port: 0, staticDir: path.join(dataDir, 'missing'), idleMs: IDLE_MS });
  t.after(() => app.close());
  const response = await call(app.url, 'GET', '/api/state');
  assert.equal(response.status, 500);
  assert.match((await json<{ error: string }>(response)).error, /^Повреждён файл данных: .*abc\.json$/);
});

test('the server seeds the example into empty data on start when asked', async t => {
  const dataDir = await tempDir(t, 'worklog-api-data-');
  const app = await createApp({ dataDir, port: 0, staticDir: path.join(dataDir, 'missing'), idleMs: IDLE_MS, profile: TEST_PROFILE, seedExample: true });
  t.after(() => app.close());
  const state = await json<WorklogState>(await call(app.url, 'GET', '/api/state'));
  assert.deepEqual(state.directions.map(direction => direction.example), [true]);
});

test('the server snapshots the data once the day has no commit of its own', async t => {
  const dataDir = await tempDir(t, 'worklog-api-data-');
  await writeFile(path.join(dataDir, 'todos.json'), '[]');
  await initDataRepo(dataDir);
  const git = (env: NodeJS.ProcessEnv, ...args: string[]): string => execFileSync('git', ['-C', dataDir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  git({ GIT_COMMITTER_DATE: '2000-01-01T12:00:00' }, 'commit', '--quiet', '--amend', '--no-edit');
  await writeFile(path.join(dataDir, 'todos.json'), '[1]');

  const app = await createApp({ dataDir, port: 0, staticDir: path.join(dataDir, 'missing'), idleMs: IDLE_MS });
  t.after(() => app.close());

  const expected = `Снимок ${localDate(new Date())}`;
  for (let i = 0; i < 50 && git({}, 'log', '-1', '--format=%s').trim() !== expected; i++) await sleep(50);
  assert.equal(git({}, 'log', '-1', '--format=%s').trim(), expected);
});

test('GET /api/profile answers the profile the app was created with', async t => {
  const dataDir = await tempDir(t, 'worklog-api-data-');
  const app = await createApp({ dataDir, port: 0, staticDir: path.join(dataDir, 'missing'), idleMs: IDLE_MS, profile: TEST_PROFILE });
  t.after(() => app.close());
  assert.deepEqual(await json(await call(app.url, 'GET', '/api/profile')), { profile: TEST_PROFILE });
});

test('GET /api/profile answers null without a profile', async t => {
  const base = await startApp(t, { profile: null });
  assert.deepEqual(await json(await call(base, 'GET', '/api/profile')), { profile: null });
});

test('close finishes with a live client connected and refuses requests afterwards', async t => {
  const dataDir = await tempDir(t, 'worklog-api-data-');
  const app = await createApp({ dataDir, port: 0, staticDir: path.join(dataDir, 'missing'), idleMs: IDLE_MS });
  const live = await fetch(`${app.url}/api/live`);
  assert.equal(live.status, 200);
  await app.close();
  await live.body?.cancel().catch(() => undefined);
  await assert.rejects(fetch(`${app.url}/api/health`));
});

test('direction delete returns 204 and removes it', async t => {
  const base = await startApp(t);
  const created = await createDirection(base, { title: 'Сео' });
  const response = await call(base, 'DELETE', `/api/directions/${created.id}`);
  assert.equal(response.status, 204);
  const state = await json<WorklogState>(await call(base, 'GET', '/api/state'));
  assert.deepEqual(state.directions, []);
});

test('manual event, tickets and links lifecycle', async t => {
  const base = await startApp(t);
  const created = await createDirection(base, { title: 'Сео' });
  const id = created.id;

  const eventResponse = await call(base, 'POST', `/api/directions/${id}/events`, { text: 'Созвонились' });
  assert.equal(eventResponse.status, 201);
  assert.equal((await json<WorkEvent>(eventResponse)).source, 'manual');

  const ticketResponse = await call(base, 'POST', `/api/directions/${id}/tickets`, { key: 'web-5586' });
  assert.equal(ticketResponse.status, 201);
  assert.equal((await json<Ticket>(ticketResponse)).key, 'WEB-5586');
  assert.equal((await call(base, 'DELETE', `/api/directions/${id}/tickets/WEB-5586`)).status, 204);

  const url = 'https://git.example.com/x/-/merge_requests/1?a=b&c=d';
  const linkResponse = await call(base, 'POST', `/api/directions/${id}/links`, { url, title: 'MR' });
  assert.equal(linkResponse.status, 201);
  assert.equal((await json<Link>(linkResponse)).kind, 'mr');
  assert.equal((await call(base, 'DELETE', `/api/directions/${id}/links?url=${encodeURIComponent(url)}`)).status, 204);

  const state = await json<WorklogState>(await call(base, 'GET', '/api/state'));
  const stored = state.directions[0];
  assert.equal(stored.events.length, 1);
  assert.deepEqual(stored.tickets, []);
  assert.deepEqual(stored.links, []);
});

test('todo create, patch, done, move and delete', async t => {
  const base = await startApp(t);
  const first = await json<Todo>(await call(base, 'POST', '/api/todos', { text: 'Первое' }));
  const second = await json<Todo>(await call(base, 'POST', '/api/todos', { text: 'Второе', requestedBy: 'Аня', due: '2026-11-10' }));
  assert.equal(second.requestedBy, 'Аня');

  const patched = await json<Todo>(await call(base, 'PATCH', `/api/todos/${first.id}`, { text: 'Первое!', done: true }));
  assert.equal(patched.text, 'Первое!');
  assert.equal(patched.done, true);

  let state = await json<WorklogState>(await call(base, 'GET', '/api/state'));
  assert.deepEqual(state.todos.map(todo => todo.id), [second.id, first.id]);

  const moved = await call(base, 'POST', `/api/todos/${first.id}/move`, { index: 0 });
  assert.equal(moved.status, 204);
  state = await json<WorklogState>(await call(base, 'GET', '/api/state'));
  assert.deepEqual(state.todos.map(todo => todo.id), [first.id, second.id]);

  assert.equal((await call(base, 'DELETE', `/api/todos/${first.id}`)).status, 204);
  assert.equal((await call(base, 'PATCH', `/api/todos/${first.id}`, { text: 'x' })).status, 404);
});

test('todo move with a non-integer index is rejected with 400', async t => {
  const base = await startApp(t);
  const todo = await json<Todo>(await call(base, 'POST', '/api/todos', { text: 'Дело' }));
  assert.equal((await call(base, 'POST', `/api/todos/${todo.id}/move`, { index: 'first' })).status, 400);
  assert.equal((await call(base, 'POST', `/api/todos/${todo.id}/move`, {})).status, 400);
});

test('link groups create and remove a link', async t => {
  const base = await startApp(t);
  const response = await call(base, 'POST', '/api/link-groups', { groupTitle: 'Рабочее', title: 'Jira', url: 'https://jira.example.com' });
  assert.equal(response.status, 201);
  const group = await json<QuickLinkGroup>(response);
  assert.equal(group.links.length, 1);

  const removal = await call(base, 'DELETE', `/api/link-groups/${group.id}/links?url=${encodeURIComponent('https://jira.example.com')}`);
  assert.equal(removal.status, 204);
  const state = await json<WorklogState>(await call(base, 'GET', '/api/state'));
  assert.deepEqual(state.linkGroups, [{ ...group, links: [] }]);
});

test('oversized body is rejected with 413', async t => {
  const base = await startApp(t);
  const response = await call(base, 'POST', '/api/directions', { title: 'x'.repeat(2 * 1024 * 1024) });
  assert.equal(response.status, 413);
});

async function staticFixture(t: TestContext): Promise<string> {
  const dir = await tempDir(t, 'worklog-api-static-');
  await mkdir(path.join(dir, 'assets'));
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>Worklog</title>');
  await writeFile(path.join(dir, 'main.js'), 'console.log(1)');
  await writeFile(path.join(dir, 'assets', 'logo.svg'), '<svg/>');
  return dir;
}

test('spa fallback serves index.html for unknown paths', async t => {
  const base = await startApp(t, { staticDir: await staticFixture(t) });
  for (const route of ['/', '/board']) {
    const response = await call(base, 'GET', route);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
    assert.match(await response.text(), /<title>Worklog<\/title>/);
  }
});

test('static files are served with their content type', async t => {
  const base = await startApp(t, { staticDir: await staticFixture(t) });
  const script = await call(base, 'GET', '/main.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') ?? '', /^text\/javascript/);
  assert.equal(await script.text(), 'console.log(1)');
  const svg = await call(base, 'GET', '/assets/logo.svg');
  assert.match(svg.headers.get('content-type') ?? '', /^image\/svg\+xml/);
});

test('static serving does not escape staticDir', async t => {
  const parent = await tempDir(t, 'worklog-api-parent-');
  const staticDir = path.join(parent, 'public');
  await mkdir(staticDir);
  await writeFile(path.join(staticDir, 'index.html'), 'INDEX');
  await writeFile(path.join(parent, 'secret.txt'), 'SECRET');
  const base = await startApp(t, { staticDir });
  const response = await call(base, 'GET', '/..%2fsecret.txt');
  assert.equal(await response.text(), 'INDEX');
});

test('missing staticDir gives 503 with a build hint', async t => {
  const base = await startApp(t);
  const response = await call(base, 'GET', '/board');
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'Фронт не собран: npm run build');
});

test('undo and redo revert and repeat the last change made through the api', async t => {
  const base = await startApp(t);
  const created = await createDirection(base, { title: 'Сео' });
  await call(base, 'PATCH', `/api/directions/${created.id}`, { title: 'SEO' });

  const undone = await call(base, 'POST', '/api/undo');
  assert.equal(undone.status, 200);
  assert.deepEqual(await json(undone), { applied: true });
  let state = await json<WorklogState>(await call(base, 'GET', '/api/state'));
  assert.equal(state.directions[0].title, 'Сео');

  assert.deepEqual(await json(await call(base, 'POST', '/api/redo')), { applied: true });
  state = await json<WorklogState>(await call(base, 'GET', '/api/state'));
  assert.equal(state.directions[0].title, 'SEO');
});

test('PATCH /api/onboarding is not undone by POST /api/undo', async t => {
  const base = await startApp(t);
  const patched = await call(base, 'PATCH', '/api/onboarding', { tourClosed: true });
  assert.equal(patched.status, 200);
  assert.match((await json<{ tourClosedAt?: string }>(patched)).tourClosedAt ?? '', /^\d{4}-/);

  assert.deepEqual(await json(await call(base, 'POST', '/api/undo')), { applied: false });
  assert.ok((await json<WorklogState>(await call(base, 'GET', '/api/state'))).onboarding?.tourClosedAt);
  assert.equal((await call(base, 'PATCH', '/api/onboarding', { tourClosed: 'да' })).status, 400);
});

test('undo and redo with nothing to apply answer applied false', async t => {
  const base = await startApp(t);
  assert.deepEqual(await json(await call(base, 'POST', '/api/undo')), { applied: false });
  assert.deepEqual(await json(await call(base, 'POST', '/api/redo')), { applied: false });
});

test('undo of a change edited elsewhere since gives 409 and changes nothing', async t => {
  const dataDir = await tempDir(t, 'worklog-api-data-');
  const app = await createApp({ dataDir, port: 0, staticDir: path.join(dataDir, 'missing'), idleMs: IDLE_MS });
  t.after(() => app.close());
  const created = await createDirection(app.url, { title: 'Сео' });
  await new Store(dataDir).renameDirection(created.id, 'Из CLI');

  const response = await call(app.url, 'POST', '/api/undo');
  assert.equal(response.status, 409);
  assert.match((await json<{ error: string }>(response)).error, /Нельзя отменить/);
  const state = await json<WorklogState>(await call(app.url, 'GET', '/api/state'));
  assert.equal(state.directions[0].title, 'Из CLI');
});

async function startAppWithFavicons(t: TestContext): Promise<string> {
  const dir = await tempDir(t, 'worklog-api-chrome-');
  writeFaviconsDb(path.join(dir, 'Favicons'), [{ pages: ['https://jira.example.com/browse/APP-1'], bitmaps: [{ width: 32, data: png(7) }] }]);
  const app = await createApp({ dataDir: path.join(dir, 'data'), port: 0, staticDir: path.join(dir, 'missing'), idleMs: IDLE_MS, chromeProfileDir: dir });
  t.after(() => app.close());
  return app.url;
}

function faviconRoute(url: string): string {
  return `/api/favicon?url=${encodeURIComponent(url)}`;
}

test('favicon comes from Chrome’s icon cache as a same-origin-only png', async t => {
  const base = await startAppWithFavicons(t);
  const response = await fetch(base + faviconRoute('https://jira.example.com/browse/APP-1'), { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(response.headers.get('cache-control') ?? '', /max-age=\d+/);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png(7));
});

test('favicon unknown to Chrome gives 404, as does every favicon without a Chrome profile', async t => {
  const base = await startAppWithFavicons(t);
  assert.equal((await fetch(base + faviconRoute('https://unknown.test/'))).status, 404);
  const bare = await startApp(t);
  assert.equal((await fetch(bare + faviconRoute('https://jira.example.com/browse/APP-1'))).status, 404);
});

test('favicon requests from other sites are refused', async t => {
  const base = await startAppWithFavicons(t);
  const response = await fetch(base + faviconRoute('https://jira.example.com/browse/APP-1'), { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(response.status, 403);
});

test('favicon without a url gives 400', async t => {
  const base = await startAppWithFavicons(t);
  assert.equal((await fetch(base + '/api/favicon')).status, 400);
});

// --- daily ---

import { chmod } from 'node:fs/promises';
import type { Daily, DailyDraft } from '../shared/model.ts';
import { currentPeriodStart } from '../shared/model.ts';

function period(): string {
  return currentPeriodStart(new Date(), []);
}

async function startDailyApp(t: TestContext, extra: Partial<AppOptions> = {}): Promise<string> {
  const dir = await tempDir(t, 'worklog-api-daily-');
  const projectsDir = path.join(dir, 'projects');
  await mkdir(path.join(projectsDir, 'p'), { recursive: true });
  const record = { type: 'user', timestamp: new Date(Date.now() - 60_000).toISOString(), sessionId: 's1', message: { role: 'user', content: 'вопрос' } };
  await writeFile(path.join(projectsDir, 'p', 's1.jsonl'), `${JSON.stringify(record)}\n`);
  const bin = path.join(dir, 'claude');
  const answer = JSON.stringify({ is_error: false, structured_output: { sessions: [], todoCandidates: [], prose: '' } });
  await writeFile(bin, `#!${process.execPath}\nprocess.stdin.resume();\nprocess.stdin.on('end', () => setTimeout(() => process.stdout.write(${JSON.stringify(answer)}), 300));\n`);
  await chmod(bin, 0o755);
  const app = await createApp({
    dataDir: path.join(dir, 'data'),
    port: 0,
    staticDir: path.join(dir, 'missing'),
    idleMs: IDLE_MS,
    summary: { claudeProjectsDir: projectsDir, agent: { agent: 'claude', bin, model: 'sonnet', cwd: dir, timeoutMs: 5000 } },
    ...extra,
  });
  t.after(() => app.close());
  return app.url;
}

async function waitForRunEnd(base: string): Promise<DailyDraft | null> {
  for (;;) {
    const { draft } = await json<WorklogState>(await call(base, 'GET', '/api/state'));
    if (draft?.run?.status !== 'running') return draft;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('PUT /api/daily/text saves the draft shown in state', async t => {
  const base = await startApp(t);
  const response = await call(base, 'PUT', '/api/daily/text', { periodStart: period(), text: 'Касаемо задачи по сео' });
  assert.equal(response.status, 200);
  const { draft } = await json<WorklogState>(await call(base, 'GET', '/api/state'));
  assert.equal(draft?.text, 'Касаемо задачи по сео');
  const stale = await call(base, 'PUT', '/api/daily/text', { periodStart: '2020-01-01T00:00:00.000Z', text: 'x' });
  assert.equal(stale.status, 400);
});

test('POST /api/daily/summary starts a run, a second one at once is 409', async t => {
  const base = await startDailyApp(t);
  const first = await call(base, 'POST', '/api/daily/summary');
  assert.equal(first.status, 202);
  assert.deepEqual(await json(first), { started: true });
  assert.equal((await call(base, 'POST', '/api/daily/summary')).status, 409);
  const draft = await waitForRunEnd(base);
  assert.equal(draft?.run, null);
  assert.equal(draft?.summary?.sessionCount, 1);
});

test('POST /api/daily/held saves the daily into state', async t => {
  const base = await startApp(t);
  const response = await call(base, 'POST', '/api/daily/held', { periodStart: period(), text: 'Дейлик' });
  assert.equal(response.status, 201);
  const daily = await json<Daily>(response);
  const state = await json<WorklogState>(await call(base, 'GET', '/api/state'));
  assert.deepEqual(state.dailies, [daily]);
});

test('undo after held restores draft and removes the daily', async t => {
  const base = await startApp(t);
  await call(base, 'PUT', '/api/daily/text', { periodStart: period(), text: 'черновик' });
  await call(base, 'POST', '/api/daily/held', { periodStart: period(), text: 'черновик' });
  assert.deepEqual(await json(await call(base, 'POST', '/api/undo')), { applied: true });
  const state = await json<WorklogState>(await call(base, 'GET', '/api/state'));
  assert.deepEqual(state.dailies, []);
  assert.equal(state.draft?.text, 'черновик');
});

test('summary items and candidates of a missing draft are 404', async t => {
  const base = await startApp(t);
  assert.equal((await call(base, 'DELETE', '/api/daily/items/x')).status, 404);
  assert.equal((await call(base, 'PATCH', '/api/daily/items/x', { directionId: null })).status, 404);
  assert.equal((await call(base, 'POST', '/api/daily/candidates/x/accept')).status, 404);
  assert.equal((await call(base, 'DELETE', '/api/daily/candidates/x')).status, 404);
});

test('a run left running by a stopped server shows as failed after start', async t => {
  const dataDir = await tempDir(t, 'worklog-api-data-');
  const store = new Store(dataDir);
  await store.beginSummaryRun();
  const app = await createApp({ dataDir, port: 0, staticDir: path.join(dataDir, 'missing'), idleMs: IDLE_MS });
  t.after(() => app.close());
  const { draft } = await json<WorklogState>(await call(app.url, 'GET', '/api/state'));
  assert.equal(draft?.run?.status, 'failed');
});

test('notes: create, patch, delete, with undo; bad links are refused', async t => {
  const base = await startApp(t);
  const dir = await createDirection(base, { title: 'US пуши' });
  const created = await call(base, 'POST', '/api/notes', { title: 'Общий origin', body: 'app.*', directionIds: [dir.id], files: [{ path: 'a.ts', line: 3 }], urls: [{ url: 'https://x.test/' }] });
  assert.equal(created.status, 201);
  const note = await json<Note>(created);
  assert.deepEqual(note.files, [{ path: 'a.ts', line: 3 }]);

  const patched = await json<Note>(await call(base, 'PATCH', `/api/notes/${note.id}`, { title: 'Origin', files: [] }));
  assert.equal(patched.title, 'Origin');
  assert.deepEqual(patched.files, []);
  assert.equal((await call(base, 'POST', '/api/undo')).status, 200);
  assert.equal((await json<WorklogState>(await call(base, 'GET', '/api/state'))).notes[0].title, 'Общий origin');

  assert.equal((await call(base, 'POST', '/api/notes', { title: 'x', files: [{ path: '/etc/passwd' }] })).status, 400);
  assert.equal((await call(base, 'POST', '/api/notes', { title: 'x', files: 'a.ts' })).status, 400);
  assert.equal((await call(base, 'DELETE', `/api/notes/${note.id}`)).status, 204);
  assert.equal((await call(base, 'DELETE', `/api/notes/${note.id}`)).status, 404);
});

test('link descriptions are set and cleared through PATCH', async t => {
  const base = await startApp(t);
  const dir = await createDirection(base, { title: 'КЭДО' });
  await call(base, 'POST', `/api/directions/${dir.id}/links`, { url: 'https://docs.example.com/', description: 'Кадровые документы' });
  const link = await json<Link>(await call(base, 'PATCH', `/api/directions/${dir.id}/links`, { url: 'https://docs.example.com/', description: 'Отпуска' }));
  assert.equal(link.description, 'Отпуска');
  assert.equal((await call(base, 'PATCH', `/api/directions/${dir.id}/links`, { url: 'https://docs.example.com/' })).status, 400);

  const group = await json<QuickLinkGroup>(await call(base, 'POST', '/api/link-groups', { groupTitle: 'Корпоративное', title: 'КЭДО', url: 'https://docs.example.com/', description: 'Подписать' }));
  assert.equal(group.links[0].description, 'Подписать');
  const cleared = await json<QuickLink>(await call(base, 'PATCH', `/api/link-groups/${group.id}/links`, { url: 'https://docs.example.com/', description: null }));
  assert.equal('description' in cleared, false);
});

test('open-file runs the editor on the line and missing lists absent files', async t => {
  const root = await tempDir(t, 'worklog-api-code-');
  await mkdir(path.join(root, 'libs'));
  await writeFile(path.join(root, 'libs', 'a.ts'), '');
  const log = path.join(await tempDir(t, 'worklog-api-log-'), 'args');
  const bin = path.join(path.dirname(log), 'webstorm');
  await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`);
  await chmod(bin, 0o755);
  const base = await startApp(t, { code: { root, editor: { name: 'jetbrains', bin } } });

  assert.equal((await call(base, 'POST', '/api/open-file', { path: 'libs/a.ts', line: 7 })).status, 204);
  let args = '';
  for (let i = 0; i < 150 && args === ''; i++) {
    await sleep(20);
    args = await readFile(log, 'utf8').catch(() => '');
  }
  assert.equal(args, `--line\n7\n${path.join(root, 'libs', 'a.ts')}\n`);
  assert.equal((await call(base, 'POST', '/api/open-file', { path: 'libs/nope.ts' })).status, 404);
  assert.equal((await call(base, 'POST', '/api/open-file', { path: '../a.ts' })).status, 400);

  await call(base, 'POST', '/api/notes', { title: 'x', files: [{ path: 'libs/a.ts' }, { path: 'libs/gone.ts', line: 2 }, { path: 'libs' }] });
  assert.deepEqual(await json<{ missing: string[] }>(await call(base, 'GET', '/api/note-files/missing')), { missing: ['libs', 'libs/gone.ts'], openable: true });
});

test('open-file without a code config answers 503 and nothing is missing', async t => {
  const base = await startApp(t);
  assert.equal((await call(base, 'POST', '/api/open-file', { path: 'a.ts' })).status, 503);
  assert.deepEqual(await json<{ missing: string[] }>(await call(base, 'GET', '/api/note-files/missing')), { missing: [], openable: false });
});

test('open-file without an editor answers 503 while missing files are still found', async t => {
  const root = await tempDir(t, 'worklog-api-code-');
  const base = await startApp(t, { code: { root, editor: null } });

  const refused = await call(base, 'POST', '/api/open-file', { path: 'a.ts' });
  assert.equal(refused.status, 503);
  assert.match((await json<{ error: string }>(refused)).error, /Редактор не выбран/);
  await call(base, 'POST', '/api/notes', { title: 'x', files: [{ path: 'gone.ts' }] });
  assert.deepEqual(await json<{ missing: string[] }>(await call(base, 'GET', '/api/note-files/missing')), { missing: ['gone.ts'], openable: false });
});

test('agent runs: launch opens Warp outside undo, finish is undoable, bad requests are 400', async t => {
  const tools = await tempDir(t, 'worklog-api-agent-');
  const calls = path.join(tools, 'calls');
  const openBin = path.join(tools, 'open');
  await writeFile(openBin, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${calls}'\n`);
  await chmod(openBin, 0o755);
  const agent: AgentConfig = { runsDir: path.join(tools, 'runs'), codeRoot: tools, bins: { claude: 'claude' }, defaultAgent: 'claude', terminal: 'warp', warpTabDir: path.join(tools, 'tabs'), openBin, osascriptBin: '/usr/bin/false' };
  const base = await startApp(t, { agent });
  const direction = await createDirection(base, { title: 'Сео', tickets: ['APP-9355'] });

  const launched = await call(base, 'POST', '/api/agent/runs', { template: 'execute', directionId: direction.id, include: ['tickets'], branch: 'feature/APP-9355' });
  assert.equal(launched.status, 201);
  const run = await json<AgentRun>(launched);
  assert.match(await readFile(calls, 'utf8'), new RegExp(`warp://tab_config/worklog-run-${run.id}`));
  assert.equal((await call(base, 'POST', '/api/undo')).status, 200);
  assert.equal((await json<WorklogState>(await call(base, 'GET', '/api/state'))).runs.length, 1);

  assert.equal((await call(base, 'POST', `/api/agent/runs/${run.id}/finish`)).status, 200);
  assert.ok((await json<WorklogState>(await call(base, 'GET', '/api/state'))).runs[0].finishedAt);
  await call(base, 'POST', '/api/undo');
  assert.equal((await json<WorklogState>(await call(base, 'GET', '/api/state'))).runs[0].finishedAt, undefined);

  assert.equal((await call(base, 'POST', '/api/agent/runs', { template: 'nope', directionId: direction.id, branch: 'dev' })).status, 400);
  assert.equal((await call(base, 'POST', '/api/agent/runs', { template: 'execute', directionId: direction.id, include: ['secrets'], branch: 'dev' })).status, 400);
  assert.equal((await call(base, 'POST', '/api/agent/runs', { template: 'question', directionId: direction.id, branch: 'dev' })).status, 400);
  assert.equal((await call(base, 'POST', '/api/agent/runs/nope/finish')).status, 404);
  assert.deepEqual(await json(await call(base, 'GET', '/api/agent/branch?name=feature/APP-9355')), { place: 'none' });
  assert.equal((await call(base, 'GET', '/api/agent/branch?name=a%20b')).status, 400);
});

test('GET /api/agent/launcher names the terminal and the folder', async t => {
  const tools = await tempDir(t, 'worklog-api-agent-');
  const agent: AgentConfig = { runsDir: path.join(tools, 'runs'), codeRoot: tools, bins: { claude: 'claude' }, defaultAgent: 'claude', terminal: 'iterm', warpTabDir: tools, openBin: '/usr/bin/false', osascriptBin: '/usr/bin/false' };
  const base = await startApp(t, { agent });
  assert.deepEqual(await json(await call(base, 'GET', '/api/agent/launcher')), { terminal: 'iterm', codeRoot: tools, agents: ['claude'], defaultAgent: 'claude' });
});

test('launcher lists installed agents and the default, shortening the home folder to ~', async t => {
  const agent: AgentConfig = { runsDir: '/tmp/runs', codeRoot: path.join(homedir(), 'Projects', 'app'), bins: { claude: 'claude', codex: 'codex' }, defaultAgent: 'codex', terminal: 'warp', warpTabDir: '/tmp', openBin: '/usr/bin/false', osascriptBin: '/usr/bin/false' };
  const base = await startApp(t, { agent });
  assert.deepEqual(await json(await call(base, 'GET', '/api/agent/launcher')), { terminal: 'warp', codeRoot: '~/Projects/app', agents: ['claude', 'codex'], defaultAgent: 'codex' });
});

test('launching an agent that is not installed answers 400', async t => {
  const agent: AgentConfig = { runsDir: '/tmp/runs', codeRoot: '/tmp', bins: { claude: 'claude' }, defaultAgent: 'claude', terminal: 'warp', warpTabDir: '/tmp', openBin: '/usr/bin/false', osascriptBin: '/usr/bin/false' };
  const base = await startApp(t, { agent });
  const direction = await createDirection(base, { title: 'Сео' });
  const missing = await call(base, 'POST', '/api/agent/runs', { agent: 'codex', template: 'execute', directionId: direction.id, branch: 'dev' });
  assert.equal(missing.status, 400);
  assert.match(JSON.stringify(await json(missing)), /Агент не установлен: codex/);
  assert.equal((await call(base, 'POST', '/api/agent/runs', { agent: 'gpt', template: 'execute', directionId: direction.id, branch: 'dev' })).status, 400);
});

test('agent runs without an agent config answer 503', async t => {
  const base = await startApp(t);
  const direction = await createDirection(base, { title: 'Сео' });
  assert.equal((await call(base, 'POST', '/api/agent/runs', { template: 'execute', directionId: direction.id, branch: 'dev' })).status, 503);
  assert.equal((await call(base, 'GET', '/api/agent/branch?name=dev')).status, 503);
  assert.equal((await call(base, 'GET', '/api/agent/launcher')).status, 503);
});

// --- Jira ---

test('GET /api/jira without jira options answers off', async t => {
  const base = await startApp(t);
  const response = await call(base, 'GET', '/api/jira');
  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { state: 'off', message: 'Jira не настроена', checkedAt: null, polling: false });
});

test('POST /api/jira/refresh polls and answers health, outside undo', async t => {
  const dataDir = await tempDir(t, 'worklog-api-data-');
  await new Store(dataDir).createDirection({ title: 'SEO', ticketKeys: ['APP-1'] });
  const app = await createApp({
    dataDir,
    port: 0,
    staticDir: path.join(await tempDir(t, 'worklog-api-static-'), 'missing'),
    idleMs: IDLE_MS,
    jira: { connect: async () => async () => [{ key: 'APP-1', status: 'In QA', segments: ['EU'] }], pollMs: 3_600_000 },
  });
  t.after(() => app.close());

  const response = await call(app.url, 'POST', '/api/jira/refresh');
  assert.equal(response.status, 200);
  assert.equal((await json<{ state: string }>(response)).state, 'ok');
  const state = await json<WorklogState>(await call(app.url, 'GET', '/api/state'));
  assert.equal(state.directions[0].tickets[0].jira?.status, 'In QA');
  assert.deepEqual(await json(await call(app.url, 'POST', '/api/undo')), { applied: false });
});

test('POST /api/jira/refresh also links the merge request of the branch', async t => {
  const dataDir = await tempDir(t, 'worklog-api-data-');
  await new Store(dataDir, { profile: TEST_PROFILE }).createDirection({ title: 'SEO', ticketKeys: ['APP-9355'] });
  let calls = 0;
  const app = await createApp({
    profile: TEST_PROFILE,
    dataDir,
    port: 0,
    staticDir: path.join(await tempDir(t, 'worklog-api-static-'), 'missing'),
    idleMs: IDLE_MS,
    mergeRequests: {
      codeRoot: '/code',
      pollMs: 3_600_000,
      lsRemote: async () => {
        calls++;
        return calls === 1 ? '' : 'abc\trefs/heads/feature/APP-9355\nabc\trefs/merge-requests/4022/head\n';
      },
    },
  });
  t.after(() => app.close());
  // the check at start finds nothing; let it finish before asking again
  while (calls === 0) await sleep(10);
  await sleep(50);

  assert.equal((await call(app.url, 'POST', '/api/jira/refresh')).status, 200);
  assert.equal(calls, 2);
  const state = await json<WorklogState>(await call(app.url, 'GET', '/api/state'));
  assert.equal(state.directions[0].links[0]?.title, 'MR !4022');
});

interface UpdateApp {
  base: string;
  runFile: string;
  launches: () => number;
  setFacts: (facts: () => Promise<UpdateFacts | null>) => void;
}

const BEHIND: UpdateFacts = { ahead: 0, behind: 1, dirty: false };

/** a server with the update by the button: facts and the launch are stand-ins, nothing reaches GitHub */
async function startUpdateApp(
  t: TestContext,
  facts: () => Promise<UpdateFacts | null>,
  daily = false,
  extra: Partial<NonNullable<AppOptions['update']>> = {},
): Promise<UpdateApp> {
  const dir = await tempDir(t, 'worklog-api-update-');
  const runFile = path.join(dir, 'logs', 'update.json');
  let current = facts;
  let launches = 0;
  const update: AppOptions['update'] = {
    facts: () => current(),
    intervalMs: 60_000,
    version: 'abc1234',
    runFile,
    launch: () => {
      launches++;
      return 4242;
    },
    alive: () => true,
    ...extra,
  };
  const base = daily ? await startDailyApp(t, { update }) : await startAppWith(t, dir, update);
  return { base, runFile, launches: () => launches, setFacts: next => (current = next) };
}

async function startAppWith(t: TestContext, dir: string, update: AppOptions['update']): Promise<string> {
  const app = await createApp({ dataDir: path.join(dir, 'data'), port: 0, staticDir: path.join(dir, 'missing'), idleMs: IDLE_MS, update });
  t.after(() => app.close());
  return app.url;
}

async function updateStatus(base: string): Promise<UpdateStatus> {
  return json<UpdateStatus>(await call(base, 'GET', '/api/update'));
}

async function waitForCheck(base: string, check: UpdateStatus['check']): Promise<void> {
  for (let i = 0; i < 100 && (await updateStatus(base)).check !== check; i++) await sleep(10);
  assert.equal((await updateStatus(base)).check, check);
}

async function errorOf(response: Response): Promise<[number, string]> {
  return [response.status, (await json<{ error: string }>(response)).error];
}

test('GET /api/update shows the check, the version and the last run', async t => {
  const app = await startUpdateApp(t, async () => BEHIND);
  await waitForCheck(app.base, 'available');
  assert.deepEqual(await updateStatus(app.base), { check: 'available', version: 'abc1234', run: null });

  const run = { phase: 'failed', startedAt: new Date().toISOString(), error: 'не удалось собрать окно' };
  await mkdir(path.dirname(app.runFile), { recursive: true });
  await writeFile(app.runFile, JSON.stringify(run));
  assert.deepEqual((await updateStatus(app.base)).run, run);
});

test('POST /api/update starts once and refuses a second click', async t => {
  const app = await startUpdateApp(t, async () => BEHIND);
  await waitForCheck(app.base, 'available');

  const answers = await Promise.all([call(app.base, 'POST', '/api/update'), call(app.base, 'POST', '/api/update')]);

  assert.deepEqual(answers.map(answer => answer.status).sort(), [202, 409]);
  assert.equal(app.launches(), 1);
  assert.equal((await updateStatus(app.base)).run?.phase, 'running');
  assert.deepEqual(await errorOf(await call(app.base, 'POST', '/api/update')), [409, 'Обновление уже идёт']);
});

test('POST /api/update refuses without a new version, with local changes and during a summary', async t => {
  const none = await startUpdateApp(t, async () => null);
  await waitForCheck(none.base, 'none');
  assert.deepEqual(await errorOf(await call(none.base, 'POST', '/api/update')), [409, 'Новой версии нет']);

  const own = await startUpdateApp(t, async () => ({ ahead: 1, behind: 1, dirty: false }));
  await waitForCheck(own.base, 'local-changes');
  assert.deepEqual(await errorOf(await call(own.base, 'POST', '/api/update')), [409, 'В папке Worklog есть свои правки — обновите её через git']);

  const daily = await startUpdateApp(t, async () => BEHIND, true);
  await waitForCheck(daily.base, 'available');
  assert.equal((await call(daily.base, 'POST', '/api/daily/summary')).status, 202);
  assert.deepEqual(await errorOf(await call(daily.base, 'POST', '/api/update')), [409, 'Идёт сборка дейлика из сессий — обновите после неё']);
  assert.equal(daily.launches(), 0);
  await waitForRunEnd(daily.base);
});

test('a running update older than 15 minutes reads as interrupted and can be started again', async t => {
  const app = await startUpdateApp(t, async () => BEHIND);
  await waitForCheck(app.base, 'available');
  const startedAt = new Date(Date.now() - 16 * 60_000).toISOString();
  await mkdir(path.dirname(app.runFile), { recursive: true });
  await writeFile(app.runFile, JSON.stringify({ phase: 'running', startedAt }));

  assert.deepEqual((await updateStatus(app.base)).run, { phase: 'failed', startedAt, error: 'обновление прервалось' });
  assert.equal((await call(app.base, 'POST', '/api/update')).status, 202);
});

test('DELETE /api/update/run clears a failed run; the summary waits for a running update', async t => {
  const app = await startUpdateApp(t, async () => BEHIND, true);
  await waitForCheck(app.base, 'available');
  assert.equal((await call(app.base, 'POST', '/api/update')).status, 202);

  assert.deepEqual(await errorOf(await call(app.base, 'POST', '/api/daily/summary')), [409, 'Идёт обновление Worklog']);
  assert.equal((await call(app.base, 'DELETE', '/api/update/run')).status, 204);
  assert.equal((await updateStatus(app.base)).run?.phase, 'running');

  await writeFile(app.runFile, JSON.stringify({ phase: 'failed', startedAt: new Date().toISOString(), error: 'не удалось скачать пакеты npm' }));
  assert.equal((await call(app.base, 'DELETE', '/api/update/run')).status, 204);
  assert.equal((await updateStatus(app.base)).run, null);
});

test('POST /api/update/check checks now and reports the result', async t => {
  const app = await startUpdateApp(t, async () => null);
  await waitForCheck(app.base, 'none');

  app.setFacts(async () => BEHIND);
  const found = await json<{ result: string; status: UpdateStatus }>(await call(app.base, 'POST', '/api/update/check'));
  assert.equal(found.result, 'available');
  assert.equal(found.status.check, 'available');

  app.setFacts(async () => {
    throw new Error('нет сети');
  });
  const failed = await json<{ result: string; status: UpdateStatus }>(await call(app.base, 'POST', '/api/update/check'));
  assert.equal(failed.result, 'unreachable');
  assert.equal(failed.status.check, 'none');
});

test('POST /api/undo does not take back an update request', async t => {
  const app = await startUpdateApp(t, async () => BEHIND);
  await waitForCheck(app.base, 'available');
  assert.equal((await call(app.base, 'POST', '/api/update')).status, 202);

  assert.deepEqual(await json(await call(app.base, 'POST', '/api/undo')), { applied: false });
  assert.equal((await updateStatus(app.base)).run?.phase, 'running');
});

test('without update options the server answers none and 503', async t => {
  const base = await startApp(t);
  assert.deepEqual(await updateStatus(base), { check: 'none', version: null, run: null });
  assert.deepEqual(await errorOf(await call(base, 'POST', '/api/update')), [503, 'Обновление по кнопке выключено']);
  assert.equal((await call(base, 'POST', '/api/update/check')).status, 503);
  assert.equal((await call(base, 'DELETE', '/api/update/run')).status, 204);
});

test('POST /api/update asks GitHub again before starting', async t => {
  const app = await startUpdateApp(t, async () => BEHIND);
  await waitForCheck(app.base, 'available');

  app.setFacts(async () => ({ ahead: 0, behind: 1, dirty: true }));
  assert.deepEqual(await errorOf(await call(app.base, 'POST', '/api/update')), [409, 'В папке Worklog есть свои правки — обновите её через git']);
  app.setFacts(async () => {
    throw new Error('нет сети');
  });
  assert.deepEqual(await errorOf(await call(app.base, 'POST', '/api/update')), [409, 'Нет связи с GitHub — попробуйте позже']);
  assert.equal(app.launches(), 0);
});

test('a corrupt run file reads as no run and can be cleared', async t => {
  const app = await startUpdateApp(t, async () => BEHIND);
  await mkdir(path.dirname(app.runFile), { recursive: true });
  await writeFile(app.runFile, '{');

  assert.equal((await updateStatus(app.base)).run, null);
  assert.equal((await call(app.base, 'DELETE', '/api/update/run')).status, 204);
});

test('a running update is judged by its process: gone reads as interrupted, alive stays running however long', async t => {
  let alive = false;
  const app = await startUpdateApp(t, async () => BEHIND, false, { alive: () => alive });
  await mkdir(path.dirname(app.runFile), { recursive: true });
  const startedAt = new Date(Date.now() - 20 * 60_000).toISOString();
  await writeFile(app.runFile, JSON.stringify({ phase: 'running', startedAt, pid: 99 }));

  assert.equal((await updateStatus(app.base)).run?.phase, 'failed');
  alive = true;
  assert.deepEqual((await updateStatus(app.base)).run, { phase: 'running', startedAt, pid: 99 });
});

test('a launch that fails answers 500 and records nothing', async t => {
  const app = await startUpdateApp(t, async () => BEHIND, false, {
    launch: () => {
      throw new Error('нет node');
    },
  });
  await waitForCheck(app.base, 'available');

  assert.deepEqual(await errorOf(await call(app.base, 'POST', '/api/update')), [500, 'Не удалось запустить обновление']);
  assert.equal((await updateStatus(app.base)).run, null);
});
