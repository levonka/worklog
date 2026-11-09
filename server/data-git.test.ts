import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DATA_GITIGNORE, commitData, dataRepoState, initDataRepo } from './data-git.ts';

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-data-git-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
}

async function codeRepo(t: TestContext, ignoreData: boolean): Promise<string> {
  const root = await tempDir(t);
  execFileSync('git', ['init', '--quiet', root]);
  await mkdir(path.join(root, 'data'));
  await writeFile(path.join(root, 'data', 'todos.json'), '[]');
  if (ignoreData) await writeFile(path.join(root, '.gitignore'), 'data/\n');
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'код');
  return path.join(root, 'data');
}

test('initDataRepo creates a repo with the first commit', async t => {
  const dataDir = path.join(await tempDir(t), 'data');
  await mkdir(dataDir);
  await writeFile(path.join(dataDir, 'todos.json'), '[]');
  assert.equal(await initDataRepo(dataDir), 'created');
  assert.equal(await dataRepoState(dataDir), 'own');
  assert.equal(git(dataDir, 'log', '--format=%an').trim(), 'Worklog');
  assert.equal(await readFile(path.join(dataDir, '.gitignore'), 'utf8'), DATA_GITIGNORE);
  assert.match(git(dataDir, 'ls-files'), /todos\.json/);
});

test('initDataRepo leaves an existing data repo alone', async t => {
  const dataDir = path.join(await tempDir(t), 'data');
  assert.equal(await initDataRepo(dataDir), 'created');
  assert.equal(await initDataRepo(dataDir), 'exists');
  assert.equal(git(dataDir, 'rev-list', '--count', 'HEAD').trim(), '1');
});

test('initDataRepo refuses data tracked by the code repo', async t => {
  const dataDir = await codeRepo(t, false);
  assert.equal(await dataRepoState(dataDir), 'shared');
  await assert.rejects(initDataRepo(dataDir), /лежит в git кода/);
  await assert.rejects(access(path.join(dataDir, '.git')));
});

test('data inside an ignoring code repo counts as none', async t => {
  const dataDir = await codeRepo(t, true);
  assert.equal(await dataRepoState(dataDir), 'none');
  assert.equal(await initDataRepo(dataDir), 'created');
  assert.equal(await dataRepoState(dataDir), 'own');
});

test('commitData commits changes and skips a clean tree', async t => {
  const dataDir = path.join(await tempDir(t), 'data');
  await assert.rejects(commitData(dataDir, 'x'), /worklog data init/);
  await initDataRepo(dataDir);
  assert.equal(await commitData(dataDir, 'ничего'), null);

  await writeFile(path.join(dataDir, 'todos.json'), '[1]');
  await mkdir(path.join(dataDir, '.lock'));
  await writeFile(path.join(dataDir, '.lock', 'owner'), '1');
  await writeFile(path.join(dataDir, 'links.json.tmp-1'), '{}');
  const hash = await commitData(dataDir, 'Снимок');
  assert.match(hash ?? '', /^[0-9a-f]{7,}$/);
  assert.equal(git(dataDir, 'show', '--name-only', '--format=%s', 'HEAD').trim(), 'Снимок\n\ntodos.json');
  assert.equal(await commitData(dataDir, 'снова'), null);
});
