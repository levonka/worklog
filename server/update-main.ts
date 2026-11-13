// node server/update-main.ts --pid <server pid> --started-at <ISO> — started by the server, detached, on «Обновить Worklog».
// Only static imports: everything is loaded before `git pull`, so the files it rewrites do not change this run.
import { execFile, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import type { UpdateRun } from '../shared/model.ts';
import { DATA_DIR, PORT, PROFILE_PATH, ROOT_DIR, UPDATE_RUN_FILE } from './config.ts';
import { worklogHealth } from './doctor.ts';
import { writeJsonAtomic } from './fs-utils.ts';
import { gitBatchEnv, gitIn } from './update-check.ts';
import { runUpdate } from './update-run.ts';

const run = promisify(execFile);
const STOP_WAIT_MS = 10_000;
const POLL_MS = 300;
const OUTPUT_LIMIT = 64 * 1024 * 1024;
// each step well under any wait of the window; a hung npm fails the update instead of stalling it
const NPM_TIMEOUT_MS = 10 * 60_000;
const CLI_TIMEOUT_MS = 2 * 60_000;
const LOGS_DIR = path.join(ROOT_DIR, 'logs');

const { values } = parseArgs({ options: { pid: { type: 'string' }, 'started-at': { type: 'string' } }, strict: true });
let serverPid = Number(values.pid);
const startedAt = values['started-at'] ?? new Date().toISOString();
const nodeDir = path.dirname(process.execPath);
// npm is a node script next to node; the app may have started with a bare PATH
const env = { ...(await gitBatchEnv(ROOT_DIR)), PATH: `${nodeDir}:${process.env.PATH ?? ''}` };
const log = (message: string): void => console.log(`${new Date().toISOString()} ${message}`);
const writeRun = (next: UpdateRun): Promise<void> => writeJsonAtomic(UPDATE_RUN_FILE, next);

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() >= until) return false;
    await sleep(POLL_MS);
  }
}

const portFree = async (): Promise<boolean> => (await worklogHealth(PORT)) === 'free';

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // already gone
  }
}

// the server may have shut down idle meanwhile: then its pid is nobody's to signal
async function stopServer(): Promise<void> {
  if (await portFree()) return;
  if (!Number.isInteger(serverPid) || serverPid <= 0) throw new Error('нет pid сервера');
  signal(serverPid, 'SIGTERM');
  if (await waitFor(portFree, STOP_WAIT_MS)) return;
  if ((await worklogHealth(PORT)) === 'worklog') signal(serverPid, 'SIGKILL');
  if (!(await waitFor(portFree, STOP_WAIT_MS))) throw new Error(`порт ${PORT} занят`);
}

// the API answers and so does the window: a build in the wrong place would pass the health check alone
async function healthy(timeoutMs: number): Promise<boolean> {
  return waitFor(async () => {
    if ((await worklogHealth(PORT)) !== 'worklog') return false;
    const page = await fetch(`http://127.0.0.1:${PORT}/`).catch(() => null);
    return page?.status === 200;
  }, timeoutMs);
}

async function startServer(): Promise<void> {
  await mkdir(LOGS_DIR, { recursive: true });
  const out = openSync(path.join(LOGS_DIR, 'server.log'), 'a');
  try {
    const child = spawn(process.execPath, [path.join(ROOT_DIR, 'server', 'main.ts')], { cwd: ROOT_DIR, env, detached: true, stdio: ['ignore', out, out] });
    // without a listener a failed spawn (node gone after an upgrade) would crash this process mid-update
    child.on('error', error => log(`Сервер не запустился: ${error.message}`));
    child.unref();
    if (child.pid === undefined) throw new Error('сервер не запустился');
    serverPid = child.pid;
  } finally {
    closeSync(out);
  }
}

async function cli(args: string[]): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [path.join(ROOT_DIR, 'cli', 'worklog.ts'), ...args], { cwd: ROOT_DIR, env, timeout: CLI_TIMEOUT_MS });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number' ? error.code : 1;
    const output = typeof error === 'object' && error !== null && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : String(error);
    return { code, output };
  }
}

// first of all: while this process lives the window shows the update as running, however long it takes
await writeRun({ phase: 'running', startedAt, pid: process.pid });

try {
  await runUpdate(
    {
      rootDir: ROOT_DIR,
      dataDir: DATA_DIR,
      profilePath: PROFILE_PATH,
      git: gitIn(ROOT_DIR),
      dataGit: gitIn(DATA_DIR),
      npm: async args => {
        await run(path.join(nodeDir, 'npm'), args, { cwd: ROOT_DIR, env, maxBuffer: OUTPUT_LIMIT, timeout: NPM_TIMEOUT_MS });
      },
      cli,
      stopServer,
      startServer,
      healthy,
      writeRun,
      now: () => new Date(),
      log,
    },
    startedAt,
  );
} catch (error) {
  // runUpdate keeps its own failures; this is whatever slipped past it
  log(`Обновление прервано: ${error instanceof Error ? error.message : String(error)}`);
  await writeRun({ phase: 'failed', startedAt, finishedAt: new Date().toISOString(), error: 'обновление прервалось' }).catch(() => undefined);
  if (await portFree()) await startServer().catch(() => undefined);
}
