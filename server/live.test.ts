import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { App } from './app.ts';
import { createApp } from './app.ts';
import { createLiveHub } from './live.ts';
import type { LiveHubOptions, Watcher } from './live.ts';
import { Store } from './store.ts';
import { TEST_PROFILE } from '../shared/test-profile.ts';
import { isRecord } from './guards.ts';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const CHANGE_FRAME = 'event: change\ndata: {}\n\n';
// longer than the 150 ms debounce: lets watcher events from creating the temp dir go out before the test acts
const SETTLE_MS = 400;
const IDLE_MS = 200;
const PROCESS_TIMEOUT_MS = 10_000;

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-live-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function startApp(t: TestContext, opts: { idleMs?: number; onIdle?: () => void } = {}): Promise<{ app: App; dataDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'worklog-live-'));
  const dataDir = path.join(root, 'data');
  const app = await createApp({
    dataDir,
    port: 0,
    staticDir: path.join(root, 'missing'),
    idleMs: opts.idleMs ?? 60_000,
    onIdle: opts.onIdle,
  });
  // close before removing the directory the app is watching
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return { app, dataDir };
}

interface LiveConnection {
  response: Response;
  received(): string;
  disconnect(): void;
}

async function connectLive(t: TestContext, base: string): Promise<LiveConnection> {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${base}/api/live`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const body = response.body;
  assert.ok(body);
  let text = '';
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for await (const chunk of body) text += decoder.decode(chunk, { stream: true });
    } catch {
      // the stream errors once the client aborts or the server drops the connection; assertions check what arrived
    }
  })();
  return { response, received: () => text, disconnect: () => controller.abort() };
}

function countChanges(text: string): number {
  return text.split(CHANGE_FRAME).length - 1;
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await sleep(10);
  }
  return true;
}

async function health(base: string): Promise<unknown> {
  return (await fetch(`${base}/api/health`)).json();
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runMain(env: Record<string, string>): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    // never the real Jira or GitLab: no certificate and no repository there
    const missing = { WORKLOG_UPDATE_CHECK: 'off', WORKLOG_JIRA_P12: path.join(ROOT_DIR, 'missing.p12'), WORKLOG_CODE_ROOT: path.join(ROOT_DIR, 'missing-code'), WORKLOG_PROFILE: path.join(ROOT_DIR, 'missing-profile.json'), WORKLOG_ENV_FILE: path.join(ROOT_DIR, 'missing-env') };
    const child = spawn(process.execPath, ['server/main.ts'], { cwd: ROOT_DIR, env: { ...process.env, ...missing, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), PROCESS_TIMEOUT_MS);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('client receives change event after CLI-like write', async t => {
  const { app, dataDir } = await startApp(t);
  const live = await connectLive(t, app.url);
  assert.equal(live.response.headers.get('content-type'), 'text/event-stream');
  assert.equal(live.response.headers.get('cache-control'), 'no-cache');
  await sleep(SETTLE_MS);
  const before = countChanges(live.received());

  await new Store(dataDir).mutate(s => {
    s.todos.push({ id: 't1', text: 'Дело', done: false, createdAt: '2026-11-05T10:00:00.000Z' });
  });

  assert.ok(await waitFor(() => countChanges(live.received()) > before, 1_000), 'no change event within 1 s');
});

test('notify sends a change to connected clients', async t => {
  const dataDir = await tempDir(t);
  const hub = createLiveHub({ dataDir, idleMs: 60_000, onIdle: () => {} });
  const server = createServer((req, res) => hub.handle(req, res));
  t.after(() => {
    hub.close();
    server.close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const live = await connectLive(t, `http://127.0.0.1:${address.port}`);
  await sleep(SETTLE_MS);
  const before = countChanges(live.received());

  hub.notify();

  assert.ok(await waitFor(() => countChanges(live.received()) > before, 1_000), 'no change event within 1 s');
});

test('lock and temp files alone do not trigger change events', async t => {
  const { app, dataDir } = await startApp(t);
  const live = await connectLive(t, app.url);
  await sleep(SETTLE_MS);
  const before = countChanges(live.received());

  await mkdir(path.join(dataDir, '.lock'));
  await mkdir(path.join(dataDir, '.lock-breaker'));
  await writeFile(path.join(dataDir, 'todos.json.tmp-1-abcd'), '[]');
  await rm(path.join(dataDir, '.lock-breaker'), { recursive: true });
  await rm(path.join(dataDir, '.lock'), { recursive: true });
  await sleep(SETTLE_MS);

  assert.equal(countChanges(live.received()), before);
});

test('onIdle fires after idleMs with no clients', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'worklog-live-'));
  const firedAt: number[] = [];
  const started = performance.now();
  const hub = createLiveHub({ dataDir, idleMs: IDLE_MS, onIdle: () => firedAt.push(performance.now()) });
  t.after(async () => {
    hub.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  assert.ok(await waitFor(() => firedAt.length > 0, IDLE_MS * 5), 'onIdle did not fire');
  const elapsed = firedAt[0] - started;
  assert.ok(elapsed >= IDLE_MS - 5, `onIdle fired too early: ${elapsed} ms`);
});

test('onIdle does not fire while a client is connected, fires after it disconnects', async t => {
  let idleCalls = 0;
  const { app } = await startApp(t, { idleMs: IDLE_MS, onIdle: () => idleCalls++ });
  const live = await connectLive(t, app.url);
  // the countdown may have fired before the connection was made
  const before = idleCalls;

  await sleep(IDLE_MS * 2);
  assert.equal(idleCalls, before);
  assert.deepEqual(await health(app.url), { ok: true, clients: 1 });

  live.disconnect();
  assert.ok(await waitFor(() => idleCalls === before + 1, IDLE_MS * 5), 'onIdle did not fire after the client left');
  assert.deepEqual(await health(app.url), { ok: true, clients: 0 });
});

test('any request restarts the idle countdown', async t => {
  let idleCalls = 0;
  const { app } = await startApp(t, { idleMs: 300, onIdle: () => idleCalls++ });
  await sleep(200);
  await health(app.url);
  await sleep(150);
  assert.equal(idleCalls, 0);
  assert.ok(await waitFor(() => idleCalls === 1, 1_000), 'onIdle did not fire after the countdown restarted');
});

class FakeWatcher extends EventEmitter {
  closed = false;

  close(): void {
    this.closed = true;
  }
}

interface FakeHub {
  url: string;
  watchers: FakeWatcher[];
  // reports a write to the newest watcher
  write(filename?: string): void;
}

async function startHub(t: TestContext, opts: Partial<LiveHubOptions> = {}): Promise<FakeHub> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'worklog-live-'));
  const watchers: FakeWatcher[] = [];
  const listeners: ((filename: string | null) => void)[] = [];
  const hub = createLiveHub({
    dataDir,
    idleMs: 60_000,
    onIdle: () => {},
    watch: (_dir, onChange): Watcher => {
      const watcher = new FakeWatcher();
      watchers.push(watcher);
      listeners.push(onChange);
      return watcher;
    },
    ...opts,
  });
  const server = createServer((req, res) => hub.handle(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    hub.close();
    server.closeAllConnections();
    server.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}`, watchers, write: (filename = 'todos.json') => listeners.at(-1)?.(filename) };
}

test('a burst of writes closer than the debounce gives exactly one change', async t => {
  const hub = await startHub(t);
  const live = await connectLive(t, hub.url);
  for (let i = 0; i < 5; i++) {
    hub.write();
    await sleep(50);
  }
  await sleep(SETTLE_MS);
  assert.equal(countChanges(live.received()), 1);
});

test('steady writes still send a change at least once a second', async t => {
  const hub = await startHub(t);
  const live = await connectLive(t, hub.url);
  const end = Date.now() + 1_500;
  let seenDuringSeries = false;
  while (Date.now() < end) {
    hub.write();
    await sleep(100);
    if (countChanges(live.received()) > 0) seenDuringSeries = true;
  }
  assert.ok(seenDuringSeries, 'no change while writes kept coming');
});

test('clients get a ping every pingMs', async t => {
  const hub = await startHub(t, { pingMs: 50 });
  const live = await connectLive(t, hub.url);
  assert.ok(await waitFor(() => live.received().includes(': ping\n\n'), 1_000), 'no ping within 1 s');
});

test('a watcher error closes it, watches again after 1 s and sends a change', async t => {
  const hub = await startHub(t);
  const live = await connectLive(t, hub.url);
  const [first] = hub.watchers;
  first.emit('error', new Error('EMFILE'));
  assert.equal(first.closed, true);
  await sleep(500);
  assert.equal(hub.watchers.length, 1);
  assert.ok(await waitFor(() => hub.watchers.length === 2, 1_500), 'did not watch again');
  assert.ok(await waitFor(() => countChanges(live.received()) === 1, 500), 'no change after watching again');
  hub.write();
  assert.ok(await waitFor(() => countChanges(live.received()) === 2, 1_000), 'the new watcher is not listened to');
});

test('second server on busy port exits with code 1', async t => {
  const { app, dataDir } = await startApp(t);
  const port = new URL(app.url).port;

  const result = await runMain({ WORKLOG_PORT: port, WORKLOG_DATA_DIR: dataDir });

  assert.equal(result.code, 1);
  assert.equal(result.stderr, `Worklog уже запущен на порту ${port}\n`);
  assert.deepEqual(await health(app.url), { ok: true, clients: 0 });
});

test('main prints its url and exits with code 0 when idle', async t => {
  const dataDir = await tempDir(t);

  const result = await runMain({ WORKLOG_PORT: '0', WORKLOG_DATA_DIR: dataDir, WORKLOG_IDLE_MS: String(IDLE_MS) });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /^Worklog: http:\/\/localhost:\d+\n$/);
  assert.equal(result.stderr, '');
});

/** what a running main answers on /api/jira with this environment */
async function jiraOfMain(t: TestContext, env: Record<string, string>): Promise<unknown> {
  const dataDir = await tempDir(t);
  const missing = { WORKLOG_UPDATE_CHECK: 'off', WORKLOG_JIRA_P12: path.join(ROOT_DIR, 'missing.p12'), WORKLOG_CODE_ROOT: path.join(ROOT_DIR, 'missing-code'), WORKLOG_ENV_FILE: path.join(ROOT_DIR, 'missing-env') };
  const child = spawn(process.execPath, ['server/main.ts'], { cwd: ROOT_DIR, env: { ...process.env, ...missing, WORKLOG_PORT: '0', WORKLOG_DATA_DIR: dataDir, ...env } });
  t.after(() => child.kill());
  let stdout = '';
  child.stdout.on('data', chunk => (stdout += chunk));
  assert.ok(await waitFor(() => /http:\/\/localhost:\d+/.test(stdout), PROCESS_TIMEOUT_MS), stdout);
  const base = /http:\/\/localhost:\d+/.exec(stdout)?.[0] ?? '';
  // the first poll settles right after start
  await sleep(SETTLE_MS);
  return (await fetch(`${base}/api/jira`)).json();
}

test('main does not poll Jira that is put off', async t => {
  const profile = path.join(await tempDir(t), 'profile.json');
  await writeFile(profile, JSON.stringify(TEST_PROFILE));

  const polled = await jiraOfMain(t, { WORKLOG_PROFILE: profile });
  const off = await jiraOfMain(t, { WORKLOG_PROFILE: profile, WORKLOG_JIRA: 'off' });

  assert.ok(isRecord(polled) && /нет сертификата/.test(String(polled.message)), JSON.stringify(polled));
  assert.deepEqual(off, { state: 'off', message: 'Jira не настроена', checkedAt: null, polling: false });
});
