import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(import.meta.dirname, 'check-leaks.sh');
const AUTHOR = { GIT_AUTHOR_NAME: 'jdoe', GIT_AUTHOR_EMAIL: 'jdoe@example.com', GIT_COMMITTER_NAME: 'jdoe', GIT_COMMITTER_EMAIL: 'jdoe@example.com' };

async function repo(t: TestContext, files: Record<string, string>): Promise<{ dir: string; list: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-leaks-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', dir]);
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  const list = path.join(dir, '..', `${path.basename(dir)}-denylist`);
  await writeFile(list, '# компания\n\nsecretcorp\nACME-\n');
  t.after(() => rm(list, { force: true }));
  return { dir, list };
}

function check(dir: string, env: Record<string, string>, args: string[] = []) {
  return spawnSync('zsh', [SCRIPT, ...args], { cwd: dir, env: { ...process.env, ...AUTHOR, ...env }, encoding: 'utf8' });
}

test('check-leaks finds a word in content and in a file name', async t => {
  const { dir, list } = await repo(t, { 'a.ts': 'const x = 1;\nconst url = "https://jira.SecretCorp.com/browse/acme-1";\n', 'secretcorp-notes.md': 'ok' });
  const result = check(dir, { WORKLOG_DENYLIST: list });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /a\.ts:2:/);
  assert.match(result.stdout, /имя файла: secretcorp-notes\.md/);
});

test('check-leaks skips integrity hashes only', async t => {
  const hash = '"integrity": "sha512-abcSECRETCORPdef+/=="';
  const clean = await repo(t, { 'package-lock.json': `{\n  ${hash},\n  "resolved": "https://registry.npmjs.org/x"\n}\n` });
  assert.equal(check(clean.dir, { WORKLOG_DENYLIST: clean.list }).status, 0);
  const leaked = await repo(t, { 'package-lock.json': `{\n  ${hash},\n  "resolved": "https://npm.secretcorp.com/x"\n}\n` });
  const result = check(leaked.dir, { WORKLOG_DENYLIST: leaked.list });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /package-lock\.json:3:/);
});

test('check-leaks refuses a denylisted author', async t => {
  const { dir, list } = await repo(t, { 'a.ts': 'ok\n' });
  const result = check(dir, { WORKLOG_DENYLIST: list, GIT_AUTHOR_EMAIL: 'me@laptop.secretcorp.local' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /автор: jdoe <me@laptop\.secretcorp\.local>/);
});

test('check-leaks checks the commit message', async t => {
  const { dir, list } = await repo(t, { 'a.ts': 'ok\n' });
  const message = path.join(dir, '.git', 'MSG');
  await writeFile(message, 'Fix ACME-12\n');
  const result = check(dir, { WORKLOG_DENYLIST: list }, ['--message', message]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /сообщение коммита: Fix ACME-12/);
  await writeFile(message, 'Fix the board\n');
  assert.equal(check(dir, { WORKLOG_DENYLIST: list }, ['--message', message]).status, 0);
});

test('check-leaks passes without a denylist', async t => {
  const { dir } = await repo(t, { 'a.ts': 'secretcorp\n' });
  const result = check(dir, { WORKLOG_DENYLIST: path.join(dir, 'missing') });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /проверка пропущена/);
});
