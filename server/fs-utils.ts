import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MARGIN_MS = 5_000;
const LOCK_NAME = '.lock';
const LOCK_BREAKER_NAME = '.lock-breaker';

export const LOCK_DIR_NAMES = [LOCK_NAME, LOCK_BREAKER_NAME] as const;

export class DataError extends Error {}

export interface LockOptions {
  staleMs?: number;
  timeoutMs?: number;
}

export function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export async function withLock<T>(dataDir: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  // a waiter has to outlast a lock abandoned by a crash
  const timeoutMs = opts.timeoutMs ?? staleMs + LOCK_TIMEOUT_MARGIN_MS;
  const lockDir = path.join(dataDir, LOCK_NAME);
  await mkdir(dataDir, { recursive: true });
  await acquireLock(lockDir, path.join(dataDir, LOCK_BREAKER_NAME), staleMs, timeoutMs);
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    await removeDir(lockDir).catch(() => undefined);
    throw error;
  }
  await removeDir(lockDir);
  return result;
}

async function acquireLock(lockDir: string, breakerDir: string, staleMs: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await tryCreateDir(lockDir)) return;
    if ((await isStale(lockDir, staleMs)) && (await breakStaleLock(lockDir, breakerDir, staleMs))) continue;
    if (Date.now() >= deadline) throw new DataError(`Не удалось получить блокировку данных: ${lockDir}`);
    await sleep(LOCK_RETRY_MS);
  }
}

/** true when this waiter removed something and may retry at once */
async function breakStaleLock(lockDir: string, breakerDir: string, staleMs: number): Promise<boolean> {
  if (!(await tryCreateDir(breakerDir))) {
    // a breaker that is itself abandoned means its owner crashed while breaking
    if (!(await isStale(breakerDir, staleMs))) return false;
    await removeDir(breakerDir);
    return true;
  }
  try {
    // another waiter may have broken the lock and someone taken it anew since the first check
    if (await isStale(lockDir, staleMs)) await removeDir(lockDir);
  } finally {
    await removeDir(breakerDir);
  }
  return true;
}

async function tryCreateDir(dir: string): Promise<boolean> {
  try {
    await mkdir(dir);
    return true;
  } catch (error) {
    if (isErrorCode(error, 'EEXIST')) return false;
    throw error;
  }
}

function removeDir(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true });
}

async function isStale(dir: string, staleMs: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(dir)).mtimeMs > staleMs;
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
}

export function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  return writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export async function readJsonFile<T>(file: string, fallback: T, guard: (v: unknown) => v is T): Promise<T> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return fallback;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new DataError(`Повреждён файл данных: ${file}`, { cause });
  }
  if (!guard(value)) throw new DataError(`Повреждён файл данных: ${file}`);
  return value;
}

export async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** the names in the directory, none when it does not exist */
export async function readdirIfExists(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return [];
    throw error;
  }
}
