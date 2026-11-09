import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const START_SCRIPT = path.join(ROOT_DIR, 'scripts', 'start.sh');
const USER_PORT = 4317;
const PROCESS_TIMEOUT_MS = 15_000;
const SERVER_START_MS = 5_000;

// stand-ins for the macOS commands: they only log their arguments, so no Chrome window or Automation prompt appears
const STUBS = {
  open: `#!/bin/sh
printf 'open %s\\n' "$*" >> "$STUB_LOG"
`,
  osascript: `#!/bin/sh
printf 'osascript %s\\n' "$*" >> "$STUB_LOG"
printf '%s\\n' "$OSASCRIPT_RESULT"
exit "\${OSASCRIPT_EXIT:-0}"
`,
};

interface Sandbox {
  port: number;
  env: NodeJS.ProcessEnv;
  calls(command: string): Promise<string[]>;
  // run before the temp dirs are removed, last added first
  cleanups: (() => Promise<void>)[];
}

async function freePort(): Promise<number> {
  for (;;) {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    server.close();
    await once(server, 'close');
    if (typeof address === 'object' && address !== null && address.port !== USER_PORT) return address.port;
  }
}

async function sandbox(t: TestContext): Promise<Sandbox> {
  const stubDir = await mkdtemp(path.join(tmpdir(), 'worklog-stubs-'));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'worklog-start-'));
  const cleanups: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await rm(stubDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });
  const log = path.join(stubDir, 'calls.log');
  await writeFile(log, '');
  for (const [name, body] of Object.entries(STUBS)) {
    await writeFile(path.join(stubDir, name), body);
    await chmod(path.join(stubDir, name), 0o755);
  }
  const port = await freePort();
  return {
    port,
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH ?? ''}`,
      // no user zsh startup files: they could put the real commands before the stubs
      ZDOTDIR: stubDir,
      STUB_LOG: log,
      WORKLOG_DATA_DIR: dataDir,
      WORKLOG_PORT: String(port),
      WORKLOG_IDLE_MS: '3000',
      WORKLOG_NODE: process.execPath,
      // never the real Jira or GitLab: no certificate and no repository there
      WORKLOG_JIRA_P12: path.join(dataDir, 'missing.p12'),
      WORKLOG_PROFILE: path.join(dataDir, 'missing-profile.json'),
      WORKLOG_ENV_FILE: path.join(dataDir, 'missing-env'),
      WORKLOG_CODE_ROOT: path.join(dataDir, 'missing-code'),
    },
    calls: async command => (await readFile(log, 'utf8')).split('\n').filter(line => line.startsWith(`${command} `)),
    cleanups,
  };
}

async function healthOf(port: number): Promise<unknown> {
  return (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
}

async function startServer(box: Sandbox): Promise<void> {
  const child = spawn(process.execPath, ['server/main.ts'], { cwd: ROOT_DIR, env: box.env, stdio: 'ignore' });
  const exited = once(child, 'exit');
  box.cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  const deadline = Date.now() + SERVER_START_MS;
  for (;;) {
    try {
      await healthOf(box.port);
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await sleep(50);
    }
  }
}

// what an open Worklog window holds: one live stream, requested as the page at localhost does
async function connectWindow(box: Sandbox): Promise<void> {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = get({ host: '127.0.0.1', port: box.port, path: '/api/live', headers: { host: `localhost:${box.port}` } }, resolve);
    // destroying the request at cleanup resets the stream; the promise has settled by then
    request.on('error', reject);
    box.cleanups.push(async () => {
      request.destroy();
    });
  });
  response.on('error', () => {});
  response.resume();
  assert.equal(response.statusCode, 200);
  assert.deepEqual(await healthOf(box.port), { ok: true, clients: 1 });
}

function runStart(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('zsh', [START_SCRIPT], { cwd: ROOT_DIR, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), PROCESS_TIMEOUT_MS);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

test('start.sh opens a new window when no window is connected', async t => {
  const box = await sandbox(t);
  await startServer(box);

  const result = await runStart({ ...box.env, OSASCRIPT_RESULT: 'found' });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await box.calls('osascript'), []);
  assert.deepEqual(await box.calls('open'), [`open -na Google Chrome --args --app=http://localhost:${box.port}`]);
});

test('start.sh raises the open window instead of opening another one', async t => {
  const box = await sandbox(t);
  await startServer(box);
  await connectWindow(box);

  const result = await runStart({ ...box.env, OSASCRIPT_RESULT: 'found' });

  assert.equal(result.code, 0, result.stderr);
  const osascript = await box.calls('osascript');
  assert.equal(osascript.length, 1);
  assert.match(osascript[0], new RegExp(`http://localhost:${box.port}$`));
  assert.deepEqual(await box.calls('open'), []);
});

test('start.sh opens a new window when Chrome does not find the connected one', async t => {
  const box = await sandbox(t);
  await startServer(box);
  await connectWindow(box);

  const result = await runStart({ ...box.env, OSASCRIPT_RESULT: 'none' });

  assert.equal(result.code, 0, result.stderr);
  assert.equal((await box.calls('osascript')).length, 1);
  assert.deepEqual(await box.calls('open'), [`open -na Google Chrome --args --app=http://localhost:${box.port}`]);
});

test('start.sh opens a new window when AppleScript fails', async t => {
  const box = await sandbox(t);
  await startServer(box);
  await connectWindow(box);

  const result = await runStart({ ...box.env, OSASCRIPT_RESULT: '', OSASCRIPT_EXIT: '1' });

  assert.equal(result.code, 0, result.stderr);
  assert.equal((await box.calls('osascript')).length, 1);
  assert.deepEqual(await box.calls('open'), [`open -na Google Chrome --args --app=http://localhost:${box.port}`]);
});

test('start.sh starts the server with the node folder first in PATH', async t => {
  const box = await sandbox(t);
  const nodeDir = await mkdtemp(path.join(tmpdir(), 'worklog-node-'));
  t.after(() => rm(nodeDir, { recursive: true, force: true }));
  const seen = path.join(nodeDir, 'path.txt');
  const fakeNode = path.join(nodeDir, 'node');
  await writeFile(fakeNode, `#!/bin/sh\nprintf '%s' "$PATH" > '${seen}'\nexit 0\n`);
  await chmod(fakeNode, 0o755);

  await runStart({ ...box.env, WORKLOG_NODE: fakeNode });

  assert.equal((await readFile(seen, 'utf8')).split(':')[0], nodeDir);
});

test('start.sh shows an alert when node is not found', async t => {
  const box = await sandbox(t);
  const env = Object.fromEntries(Object.entries(box.env).flatMap(([name, value]) => (value === undefined || name === 'WORKLOG_NODE' ? [] : [[name, value]])));
  const stubDir = (box.env.PATH ?? '').split(':')[0];

  const result = await runStart({ ...env, PATH: `${stubDir}:/usr/bin:/bin` });

  assert.equal(result.code, 1);
  assert.deepEqual(await box.calls('open'), []);
  const osascript = await box.calls('osascript');
  assert.equal(osascript.length, 1);
  assert.match(osascript[0], /Не найден node/);
});

test('start.sh shows an alert and opens no window when the server does not come up', async t => {
  const box = await sandbox(t);
  const nodeDir = await mkdtemp(path.join(tmpdir(), 'worklog-node-'));
  t.after(() => rm(nodeDir, { recursive: true, force: true }));
  // exits at once and prints nothing, so logs/server.log stays clean
  const deadNode = path.join(nodeDir, 'node');
  await writeFile(deadNode, '#!/bin/sh\nexit 0\n');
  await chmod(deadNode, 0o755);

  const result = await runStart({ ...box.env, WORKLOG_NODE: deadNode });

  assert.equal(result.code, 1);
  assert.deepEqual(await box.calls('open'), []);
  const osascript = await box.calls('osascript');
  assert.equal(osascript.length, 1);
  assert.match(osascript[0], /display alert "Worklog не запустился" message "Подробности: logs\/server\.log"/);
});
