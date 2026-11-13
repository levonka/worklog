import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UpdateFacts } from '../shared/model.ts';
import { createUpdateChecker, currentVersion, gitIn, updateFacts } from './update-check.ts';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
}

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-update-check-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** a bare origin, the clone under test and a second clone that publishes new versions */
async function repos(t: TestContext): Promise<{ origin: string; clone: string; publisher: string }> {
  const dir = await tempDir(t);
  const origin = path.join(dir, 'origin.git');
  const publisher = path.join(dir, 'publisher');
  const clone = path.join(dir, 'clone');
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  execFileSync('git', ['clone', '--quiet', origin, publisher]);
  await writeFile(path.join(publisher, 'README.md'), 'v1\n');
  await writeFile(path.join(publisher, '.gitignore'), 'logs/\n');
  git(publisher, 'add', '-A');
  git(publisher, 'commit', '--quiet', '-m', 'v1');
  git(publisher, 'push', '--quiet', 'origin', 'HEAD:main');
  execFileSync('git', ['clone', '--quiet', origin, clone]);
  return { origin, clone, publisher };
}

async function publish(publisher: string, text: string): Promise<void> {
  await writeFile(path.join(publisher, 'README.md'), `${text}\n`);
  git(publisher, 'commit', '--quiet', '-am', text);
  git(publisher, 'push', '--quiet', 'origin', 'HEAD:main');
}

test('updateFacts sees a new commit on the tracked branch', async t => {
  const { clone, publisher } = await repos(t);
  assert.deepEqual(await updateFacts(gitIn(clone)), { ahead: 0, behind: 0, dirty: false });

  await publish(publisher, 'v2');

  assert.deepEqual(await updateFacts(gitIn(clone)), { ahead: 0, behind: 1, dirty: false });
  assert.match((await currentVersion(gitIn(clone))) ?? '', /^[0-9a-f]{7,}$/);
});

test('updateFacts sees own commits and edits, not ignored files', async t => {
  const { clone, publisher } = await repos(t);
  await publish(publisher, 'v2');
  await writeFile(path.join(clone, '.gitignore'), 'logs/\n');
  execFileSync('mkdir', ['-p', path.join(clone, 'logs')]);
  await writeFile(path.join(clone, 'logs', 'server.log'), 'log\n');
  assert.deepEqual(await updateFacts(gitIn(clone)), { ahead: 0, behind: 1, dirty: false });

  await writeFile(path.join(clone, 'README.md'), 'mine\n');
  assert.deepEqual(await updateFacts(gitIn(clone)), { ahead: 0, behind: 1, dirty: true });

  git(clone, 'commit', '--quiet', '-am', 'mine');
  assert.deepEqual(await updateFacts(gitIn(clone)), { ahead: 1, behind: 1, dirty: false });
});

test('updateFacts is null without upstream, on a detached HEAD or without its remote, and throws when fetch fails', async t => {
  const { origin, clone } = await repos(t);
  git(clone, 'switch', '--quiet', '-c', 'own');
  assert.equal(await updateFacts(gitIn(clone)), null);

  git(clone, 'switch', '--quiet', '--detach', 'main');
  assert.equal(await updateFacts(gitIn(clone)), null);

  git(clone, 'switch', '--quiet', 'main');
  git(clone, 'remote', 'set-url', 'origin', `${origin}-gone`);
  await assert.rejects(updateFacts(gitIn(clone)));

  git(clone, 'remote', 'remove', 'origin');
  assert.equal(await updateFacts(gitIn(clone)), null);
  assert.equal(await currentVersion(gitIn(path.join(origin, '..'))), null);
});

test('the checker asks at once, then on the timer, and calls onChange only on a change', async t => {
  const answers: (UpdateFacts | null)[] = [null, { ahead: 0, behind: 1, dirty: false }, { ahead: 0, behind: 2, dirty: false }];
  let asked = 0;
  let changes = 0;
  const checker = createUpdateChecker({ facts: async () => answers[Math.min(asked++, answers.length - 1)], intervalMs: 10, onChange: () => changes++ });
  t.after(() => checker.close());

  checker.start();
  await new Promise(resolve => setTimeout(resolve, 60));

  assert.ok(asked >= 3);
  assert.equal(checker.check(), 'available');
  assert.equal(changes, 1);
});

test('the checks on start and on the timer wait while an update runs', async t => {
  let asked = 0;
  let busy = true;
  const checker = createUpdateChecker({
    facts: async () => {
      asked++;
      return null;
    },
    intervalMs: 10,
    onChange: () => {},
    busy: async () => busy,
  });
  t.after(() => checker.close());

  checker.start();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(asked, 0);

  busy = false;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(asked > 0);
});

test('refresh reports unreachable when fetch fails and keeps the check at none', async () => {
  let fail = false;
  const checker = createUpdateChecker({
    facts: async () => {
      if (fail) throw new Error('нет сети');
      return { ahead: 0, behind: 1, dirty: false };
    },
    intervalMs: 60_000,
    onChange: () => {},
  });
  assert.equal(await checker.refresh(), 'available');

  fail = true;
  const [first, second] = await Promise.all([checker.refresh(), checker.refresh()]);

  assert.equal(first, 'unreachable');
  assert.equal(second, 'unreachable');
  assert.equal(checker.check(), 'none');
});
