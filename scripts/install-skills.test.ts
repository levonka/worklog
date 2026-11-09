import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT_DIR, 'scripts', 'install-skills.sh');

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-skills-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function install(target: string, binDir: string = path.join(target, '.bin')) {
  // a home without agents: only the folder given here is a target
  return spawnSync('zsh', [SCRIPT], { env: { ...process.env, HOME: path.join(target, '.home'), CLAUDE_SKILLS_DIR: target, CODEX_SKILLS_DIR: '', WORKLOG_BIN_DIR: binDir }, encoding: 'utf8' });
}

test('install-skills links every skill folder and can run again', async t => {
  const target = path.join(await tempDir(t), 'skills');
  const skills = (await readdir(path.join(ROOT_DIR, 'skills'), { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
  assert.ok(skills.includes('worklog-update') && skills.includes('worklog-tabs') && skills.includes('worklog') && skills.includes('worklog-setup'));

  const first = install(target);
  assert.equal(first.status, 0, first.stderr);
  for (const name of skills) assert.equal(await readlink(path.join(target, name)), path.join(ROOT_DIR, 'skills', name));

  const again = install(target);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /worklog-update: уже установлен/);
});

test('install-skills leaves a foreign folder or link with the same name alone', async t => {
  const target = await tempDir(t);
  await mkdir(path.join(target, 'worklog-update'));
  await writeFile(path.join(target, 'worklog-update', 'SKILL.md'), 'чужой');
  const other = await tempDir(t);
  await symlink(other, path.join(target, 'worklog-tabs'));

  const result = install(target);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /worklog-update: пропускаю/);
  assert.match(result.stderr, /worklog-tabs: пропускаю/);
  assert.ok((await lstat(path.join(target, 'worklog-update'))).isDirectory());
  assert.equal(await readlink(path.join(target, 'worklog-tabs')), other);
});

test('install-skills links the CLI into the bin folder and can run again', async t => {
  const dir = await tempDir(t);
  const binDir = path.join(dir, 'bin');
  const first = install(path.join(dir, 'skills'), binDir);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(await readlink(path.join(binDir, 'worklog')), path.join(ROOT_DIR, 'bin', 'worklog'));

  const again = install(path.join(dir, 'skills'), binDir);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /worklog: уже установлен/);
});

test('install-skills leaves a foreign worklog in the bin folder alone', async t => {
  const dir = await tempDir(t);
  const binDir = path.join(dir, 'bin');
  await mkdir(binDir);
  await writeFile(path.join(binDir, 'worklog'), 'чужой');

  const result = install(path.join(dir, 'skills'), binDir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /worklog: пропускаю/);
  assert.ok((await lstat(path.join(binDir, 'worklog'))).isFile());
});

function installAt(home: string) {
  return spawnSync('zsh', [SCRIPT], { env: { ...process.env, HOME: home, CLAUDE_SKILLS_DIR: '', CODEX_SKILLS_DIR: '', WORKLOG_BIN_DIR: path.join(home, 'bin') }, encoding: 'utf8' });
}

test('install-skills links into both agents when both are present', async t => {
  const home = await tempDir(t);
  await mkdir(path.join(home, '.claude'));
  await mkdir(path.join(home, '.codex'));
  const result = installAt(home);
  assert.equal(result.status, 0, result.stderr);
  for (const dir of ['.claude/skills', '.agents/skills']) {
    assert.equal(await readlink(path.join(home, dir, 'worklog-update')), path.join(ROOT_DIR, 'skills', 'worklog-update'));
  }
});

test('install-skills links only for the agent that is present', async t => {
  const home = await tempDir(t);
  await mkdir(path.join(home, '.codex'));
  const result = installAt(home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readlink(path.join(home, '.agents', 'skills', 'worklog')), path.join(ROOT_DIR, 'skills', 'worklog'));
  await assert.rejects(lstat(path.join(home, '.claude')));
});

test('install-skills says there is nowhere to install without an agent', async t => {
  const result = installAt(await tempDir(t));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ни Claude Code .* ни Codex/);
});
