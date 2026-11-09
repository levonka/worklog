import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(import.meta.dirname, 'settings.sh');

function setting(name: string, env: Record<string, string>): string {
  const result = spawnSync('zsh', ['-c', `source '${SCRIPT}'; worklog_setting ${name}; print -r -- "$REPLY"`], { env: { PATH: process.env.PATH ?? '', HOME: homedir(), ...env }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.replace(/\n$/, '');
}

async function envFile(t: TestContext, text: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'env');
  await writeFile(file, text);
  return file;
}

test('worklog_setting reads the env file as the server does and prefers the environment', async t => {
  const file = await envFile(t, 'WORKLOG_PORT=1\nWORKLOG_PORT="4400"\r\nWORKLOG_CODE_ROOT=~/Projects/app\n');
  assert.equal(setting('WORKLOG_PORT', { WORKLOG_ENV_FILE: file }), '4400');
  assert.equal(setting('WORKLOG_CODE_ROOT', { WORKLOG_ENV_FILE: file }), path.join(homedir(), 'Projects/app'));
  assert.equal(setting('WORKLOG_PORT', { WORKLOG_ENV_FILE: file, WORKLOG_PORT: '5000' }), '5000');
  assert.equal(setting('WORKLOG_EDITOR', { WORKLOG_ENV_FILE: file }), '');
  assert.equal(setting('WORKLOG_PORT', { WORKLOG_ENV_FILE: '/nonexistent' }), '');
});
