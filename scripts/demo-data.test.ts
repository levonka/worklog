import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseProfile } from '../shared/model.ts';
import { seedDemo } from './demo-data.ts';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-demo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('seedDemo fills every column and links only to invented hosts', async t => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'data');
  const profilePath = path.join(dir, 'profile.json');

  await seedDemo(dataDir, profilePath);

  parseProfile(JSON.parse(await readFile(profilePath, 'utf8')));
  const env = { ...process.env, WORKLOG_DATA_DIR: dataDir, WORKLOG_PROFILE: profilePath, WORKLOG_ENV_FILE: '/nonexistent', WORKLOG_JIRA: 'off' };
  const json = execFileSync(path.join(ROOT_DIR, 'bin', 'worklog'), ['state', '--json'], { env, encoding: 'utf8' });
  const state: { directions: { status: string }[]; todos: unknown[]; notes?: unknown[] } = JSON.parse(json);
  assert.deepEqual(new Set(state.directions.map(direction => direction.status)), new Set(['in_progress', 'waiting', 'in_review', 'testing', 'awaiting_release', 'parked', 'done']));
  assert.ok(state.todos.length >= 4);

  const hosts = new Set(Array.from(json.matchAll(/https:\/\/([^/"\s]+)/g), match => match[1]));
  for (const host of hosts) assert.match(host, /(^|\.)(example\.com|figma\.com)$/, host);
});
