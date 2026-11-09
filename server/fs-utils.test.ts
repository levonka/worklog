import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DataError, readJsonFile, withLock, writeJsonAtomic } from './fs-utils.ts';

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-fs-'));
  t.after(async () => {
    await chmod(dir, 0o755);
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function isArrayOfNumbers(v: unknown): v is number[] {
  return Array.isArray(v) && v.every(item => typeof item === 'number');
}

test('waiters on one abandoned lock take it over one at a time', async t => {
  let overlaps = 0;
  // the race needs waiters arriving a little apart, so it is repeated over many rounds
  for (let round = 0; round < 30; round++) {
    const dir = await tempDir(t);
    const lockDir = path.join(dir, '.lock');
    await mkdir(lockDir);
    const past = new Date(Date.now() - 60_000);
    await utimes(lockDir, past, past);
    let holders = 0;
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        sleep(i % 3).then(() =>
          withLock(dir, async () => {
            holders++;
            if (holders > 1) overlaps++;
            await sleep(1);
            holders--;
          }),
        ),
      ),
    );
    await assert.rejects(access(lockDir), { code: 'ENOENT' });
  }
  assert.equal(overlaps, 0);
});

test('a waiter outlasts a lock left by a crash until it counts as abandoned', async t => {
  const dir = await tempDir(t);
  await mkdir(path.join(dir, '.lock'));
  const started = Date.now();

  const result = await withLock(dir, async () => 'got it', { staleMs: 300 });

  assert.equal(result, 'got it');
  assert.ok(Date.now() - started >= 250, 'took over a lock that was still fresh');
});

test('the error of fn is kept when releasing the lock fails as well', async t => {
  const dir = await tempDir(t);
  await assert.rejects(
    withLock(dir, async () => {
      // a read-only data dir makes removing .lock fail
      await chmod(dir, 0o555);
      throw new Error('ошибка внутри');
    }),
    { message: 'ошибка внутри' },
  );
});

test('lock timeout and corrupt files raise DataError', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'x.json');
  await writeFile(file, '{');
  await assert.rejects(readJsonFile(file, [], isArrayOfNumbers), DataError);
  await writeFile(file, '{"a":1}');
  await assert.rejects(readJsonFile(file, [], isArrayOfNumbers), DataError);

  await mkdir(path.join(dir, '.lock'));
  await assert.rejects(withLock(dir, async () => {}, { staleMs: 60_000, timeoutMs: 100 }), DataError);
});

test('writeJsonAtomic writes formatted JSON and leaves no temp file', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'nested', 'a.json');
  await writeJsonAtomic(file, [1, 2]);
  assert.equal(await readFile(file, 'utf8'), '[\n  1,\n  2\n]\n');
  assert.deepEqual(await readJsonFile(file, [], isArrayOfNumbers), [1, 2]);
});
