import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Direction, WorklogState } from '../shared/model.ts';
import { EMPTY_STATE, ticketFromKey } from '../shared/model.ts';
import { COMMANDS, SNSS_HEADER, int32, navigation, record, snss } from './chrome-tabs.fixture.ts';
import { matchTabs, parseSnss, readChromeTabs } from './chrome-tabs.ts';
import { TEST_PROFILE } from '../shared/test-profile.ts';

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-tabs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('parseSnss returns open tabs by window and position with the selected navigation', () => {
  const data = snss(
    [
      { id: 11, window: 2, index: 0, url: 'https://b.test/', title: 'B' },
      { id: 10, window: 1, index: 1, url: 'https://a1.test/', title: 'A1' },
      { id: 12, window: 1, index: 0, url: 'https://a0.test/', title: 'Ёлка 🎄' },
    ],
    [navigation(10, 1, 'https://a1.test/next', 'A1 дальше'), record(COMMANDS.setSelectedNavigationIndex, int32(10, 1))],
  );
  assert.deepEqual(parseSnss(data), [
    { window: 1, index: 0, title: 'Ёлка 🎄', url: 'https://a0.test/' },
    { window: 1, index: 1, title: 'A1 дальше', url: 'https://a1.test/next' },
    { window: 2, index: 0, title: 'B', url: 'https://b.test/' },
  ]);
});

test('parseSnss skips closed tabs, closed windows and non-web pages', () => {
  const data = snss(
    [
      { id: 1, window: 1, index: 0, url: 'https://open.test/', title: 'open' },
      { id: 2, window: 1, index: 1, url: 'https://closed-tab.test/', title: 'closed tab' },
      { id: 3, window: 9, index: 0, url: 'https://closed-window.test/', title: 'closed window' },
      { id: 4, window: 1, index: 2, url: 'chrome://newtab/', title: 'Новая вкладка' },
    ],
    [record(COMMANDS.tabClosed, int32(2, 0)), record(COMMANDS.windowClosed, int32(9, 0))],
  );
  assert.deepEqual(
    parseSnss(data).map(t => t.title),
    ['open'],
  );
});

test('parseSnss falls back to the last navigation and follows pruning', () => {
  const data = Buffer.concat([
    SNSS_HEADER,
    record(COMMANDS.setTabWindow, int32(1, 5)),
    navigation(5, 0, 'https://n0.test/', 'n0'),
    navigation(5, 1, 'https://n1.test/', 'n1'),
    navigation(5, 2, 'https://n2.test/', 'n2'),
    record(COMMANDS.setSelectedNavigationIndex, int32(5, 7)),
    record(COMMANDS.tabNavigationPathPruned, int32(5, 0, 2)),
    record(COMMANDS.setSelectedNavigationIndex, int32(5, 0)),
  ]);
  assert.deepEqual(
    parseSnss(data).map(t => t.title),
    ['n2'],
  );

  const unselected = Buffer.concat([SNSS_HEADER, navigation(6, 0, 'https://x0.test/', 'x0'), navigation(6, 3, 'https://x3.test/', 'x3')]);
  assert.deepEqual(
    parseSnss(unselected).map(t => t.title),
    ['x3'],
  );
});

test('parseSnss keeps what was read before a cut or broken record', () => {
  const whole = snss([{ id: 1, window: 1, index: 0, url: 'https://kept.test/', title: 'kept' }]);
  const cut = navigation(2, 0, 'https://cut.test/', 'cut');
  const broken = record(COMMANDS.updateTabNavigation, Buffer.concat([int32(0, 3, 0), int32(1000)]));
  const data = Buffer.concat([whole, broken, cut.subarray(0, cut.length - 3)]);
  assert.deepEqual(
    parseSnss(data).map(t => t.title),
    ['kept'],
  );
});

test('parseSnss rejects a file that is not SNSS', () => {
  assert.throws(() => parseSnss(Buffer.from('not a session')), /SNSS/);
});

test('readChromeTabs reads the newest session file of the last used profile', async t => {
  const chromeDir = await tempDir(t);
  await writeFile(path.join(chromeDir, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 1' } }));
  const sessions = path.join(chromeDir, 'Profile 1', 'Sessions');
  await mkdir(sessions, { recursive: true });
  const old = path.join(sessions, 'Session_200');
  const fresh = path.join(sessions, 'Session_100');
  await writeFile(old, snss([{ id: 1, window: 1, index: 0, url: 'https://old.test/', title: 'old' }]));
  await writeFile(fresh, snss([{ id: 1, window: 1, index: 0, url: 'https://fresh.test/', title: 'fresh' }]));
  await writeFile(path.join(sessions, 'Tabs_300'), 'ignored');
  await utimes(old, new Date('2026-11-01'), new Date('2026-11-01'));
  await utimes(fresh, new Date('2026-11-05'), new Date('2026-11-05'));

  assert.deepEqual(
    (await readChromeTabs(chromeDir)).map(t => t.title),
    ['fresh'],
  );
});

test('readChromeTabs says where it looked when there is no session file', async t => {
  const chromeDir = await tempDir(t);
  await assert.rejects(readChromeTabs(chromeDir), /Не нашёл файл сессии Chrome в .*Default.Sessions/);
});

function direction(id: string, keys: string[], links: string[] = []): Direction {
  return {
    id,
    title: `Направление ${id}`,
    status: 'in_progress',
    tickets: keys.map(key => ticketFromKey(key, TEST_PROFILE)),
    links: links.map(url => ({ title: url, url, kind: 'other' })),
    events: [],
    order: 0,
    createdAt: '2026-11-05T00:00:00Z',
    updatedAt: '2026-11-05T00:00:00Z',
  };
}

test('matchTabs finds ticket keys, their directions and already saved URLs', () => {
  const state: WorklogState = {
    ...EMPTY_STATE,
    directions: [direction('seo', ['APP-7301', 'WEB-4410'], ['https://wiki.test/brd']), direction('uni', ['APP-8962'])],
    linkGroups: [{ id: 'g', title: 'Каждый день', links: [{ title: 'Почта', url: 'https://mail.test/' }] }],
  };
  const tab = (title: string, url: string) => ({ window: 1, index: 0, title, url });
  const matched = matchTabs(
    [
      tab('Ветка', 'https://git.test/-/tree/feature/APP-7301_WEB-4410'),
      tab('[APP-8962] Унификация', 'https://jira.example.com/browse/APP-8962'),
      tab('BRD', 'https://wiki.test/brd#section'),
      tab('Figma REG-3425', 'https://wiki.test/brd'),
      tab('Почта', 'https://mail.test/'),
      tab('CRM-14964', 'https://jira.example.com/login'),
    ],
    state,
  );
  assert.deepEqual(
    matched.map(m => ({ keys: m.keys, directions: m.directions.map(d => d.id), saved: m.saved })),
    [
      { keys: ['APP-7301', 'WEB-4410'], directions: ['seo'], saved: false },
      { keys: ['APP-8962'], directions: ['uni'], saved: true },
      { keys: [], directions: ['seo'], saved: true },
      { keys: ['REG-3425'], directions: ['seo'], saved: true },
      { keys: [], directions: [], saved: true },
      { keys: ['CRM-14964'], directions: [], saved: false },
    ],
  );
});
