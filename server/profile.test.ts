import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TEST_PROFILE } from '../shared/test-profile.ts';
import { loadProfile } from './profile.ts';

async function profileFile(t: TestContext, text: string | null): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-profile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'profile.json');
  if (text !== null) await writeFile(file, text);
  return file;
}

test('loadProfile returns null without a file', async t => {
  assert.deepEqual(await loadProfile(await profileFile(t, null)), { profile: null, error: null });
});

test('loadProfile reads the test profile', async t => {
  assert.deepEqual(await loadProfile(await profileFile(t, JSON.stringify(TEST_PROFILE))), { profile: TEST_PROFILE, error: null });
});

test('loadProfile reports broken JSON with the path', async t => {
  const file = await profileFile(t, '{ "version": 1,');
  const loaded = await loadProfile(file);
  assert.equal(loaded.profile, null);
  assert.ok(loaded.error?.includes(file), loaded.error ?? '');
});

test('loadProfile reports the wrong field', async t => {
  const loaded = await loadProfile(await profileFile(t, JSON.stringify({ ...TEST_PROFILE, jira: { ...TEST_PROFILE.jira, url: 5 } })));
  assert.equal(loaded.profile, null);
  assert.ok(loaded.error?.includes('jira.url'), loaded.error ?? '');
});
