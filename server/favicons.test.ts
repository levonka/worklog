import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromeProfileDir, createFavicons } from './favicons.ts';
import type { FixtureIcon } from './favicons.fixture.ts';
import { png, writeFaviconsDb } from './favicons.fixture.ts';

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-favicons-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function setup(t: TestContext, icons: FixtureIcon[], opts: { snapshotMs?: number } = {}) {
  const profileDir = await tempDir(t);
  writeFaviconsDb(path.join(profileDir, 'Favicons'), icons);
  const favicons = createFavicons({ profileDir, snapshotMs: opts.snapshotMs ?? 60_000 });
  t.after(() => favicons.close());
  return { favicons, profileDir };
}

test('finds the icon of the exact page, preferring the 32px bitmap', async t => {
  const { favicons } = await setup(t, [
    { pages: ['https://jira.example.com/browse/APP-1', 'https://jira.example.com/browse/APP-2'], bitmaps: [{ width: 16, data: png(1) }] },
    { pages: ['https://jira.example.com/secure/Dashboard.jspa'], bitmaps: [{ width: 16, data: png(2) }, { width: 32, data: png(3) }, { width: 64, data: png(4) }] },
  ]);

  assert.deepEqual(await favicons.find('https://jira.example.com/secure/Dashboard.jspa'), png(3));
});

test('for a page Chrome has no icon of, takes the icon most pages of the site use', async t => {
  const { favicons } = await setup(t, [
    { pages: ['https://www.figma.com/login'], bitmaps: [{ width: 32, data: png(1) }] },
    { pages: ['https://www.figma.com/design/a', 'https://www.figma.com/design/b'], bitmaps: [{ width: 16, data: png(2) }] },
  ]);

  assert.deepEqual(await favicons.find('https://www.figma.com/design/new'), png(2));
  assert.deepEqual(await favicons.find('https://www.figma.com'), png(2));
});

test('a bitmap under 32px is used when it is all there is', async t => {
  const { favicons } = await setup(t, [{ pages: ['https://wl.example.com/'], bitmaps: [{ width: 16, data: png(1) }] }]);
  assert.deepEqual(await favicons.find('https://wl.example.com/'), png(1));
});

test('other origins do not count: another host, port or scheme, or a longer host name', async t => {
  const { favicons } = await setup(t, [
    {
      pages: ['https://shop.example.com.evil.test/', 'https://shop.example.com:8443/', 'http://shop.example.com/', 'https://sub.shop.example.com/'],
      bitmaps: [{ width: 32, data: png(1) }],
    },
  ]);
  assert.equal(await favicons.find('https://shop.example.com/live'), null);
});

test('bitmaps that are not PNG are skipped', async t => {
  const { favicons } = await setup(t, [{ pages: ['https://a.test/'], bitmaps: [{ width: 32, data: Uint8Array.from([1, 2, 3]) }] }]);
  assert.equal(await favicons.find('https://a.test/'), null);
});

test('no icon without a Chrome profile or for a link that is not http', async t => {
  const favicons = createFavicons({ profileDir: path.join(await tempDir(t), 'missing'), snapshotMs: 0 });
  t.after(() => favicons.close());
  assert.equal(await favicons.find('https://a.test/'), null);

  const { favicons: withDb } = await setup(t, [{ pages: ['file:///etc/'], bitmaps: [{ width: 32, data: png(1) }] }]);
  assert.equal(await withDb.find('file:///etc/'), null);
  assert.equal(await withDb.find('not a url'), null);
});

test('rereads Chrome’s database once the snapshot is older than snapshotMs', async t => {
  const { favicons, profileDir } = await setup(t, [{ pages: ['https://a.test/'], bitmaps: [{ width: 32, data: png(1) }] }], { snapshotMs: 0 });
  assert.deepEqual(await favicons.find('https://a.test/'), png(1));

  await rm(path.join(profileDir, 'Favicons'));
  writeFaviconsDb(path.join(profileDir, 'Favicons'), [{ pages: ['https://a.test/'], bitmaps: [{ width: 32, data: png(2) }] }]);

  assert.deepEqual(await favicons.find('https://a.test/'), png(2));
});

test('chromeProfileDir picks the last used profile, else Default', async t => {
  const root = await tempDir(t);
  assert.equal(await chromeProfileDir(root), path.join(root, 'Default'));

  await writeFile(path.join(root, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 2' } }));
  assert.equal(await chromeProfileDir(root), path.join(root, 'Profile 2'));

  await writeFile(path.join(root, 'Local State'), JSON.stringify({ profile: { last_used: '../outside' } }));
  assert.equal(await chromeProfileDir(root), path.join(root, 'Default'));

  await mkdir(path.join(root, 'broken'));
  await writeFile(path.join(root, 'Local State'), '{');
  assert.equal(await chromeProfileDir(root), path.join(root, 'Default'));
});
