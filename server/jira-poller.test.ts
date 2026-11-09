import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { JiraFetch } from './jira.ts';
import { JiraError } from './jira.ts';
import type { JiraPoller } from './jira-poller.ts';
import { createJiraPoller } from './jira-poller.ts';
import type { JiraIssue } from './store.ts';
import { Store } from './store.ts';
import { TEST_PROFILE } from '../shared/test-profile.ts';

const T1 = new Date('2026-11-06T09:00:00.000Z');
const T2 = new Date('2026-11-06T09:05:00.000Z');
const T3 = new Date('2026-11-06T09:10:00.000Z');

async function tempStore(t: TestContext): Promise<Store> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-jira-poller-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new Store(dir, { profile: TEST_PROFILE });
}

function poller(t: TestContext, store: Store, fetch: JiraFetch | string, opts: { now?: () => Date; onHealth?: () => void; pollMs?: number } = {}): JiraPoller {
  return connecting(t, store, async () => fetch, opts);
}

function connecting(t: TestContext, store: Store, connect: () => Promise<JiraFetch | string>, opts: { now?: () => Date; onHealth?: () => void; pollMs?: number } = {}): JiraPoller {
  const created = createJiraPoller({ store, connect, pollMs: opts.pollMs ?? 3_600_000, onHealth: opts.onHealth ?? (() => {}), now: opts.now ?? (() => T1) });
  t.after(() => created.close());
  return created;
}

function issue(key: string, status: string): JiraIssue {
  return { key, status, segments: ['EU'] };
}

test('refresh stores statuses and reports ok', async t => {
  const store = await tempStore(t);
  await store.createDirection({ title: 'SEO', ticketKeys: ['APP-1'] });
  const jira = poller(t, store, async () => [issue('APP-1', 'Open')]);

  assert.deepEqual(await jira.refresh(), { state: 'ok', message: null, checkedAt: T1.toISOString(), polling: false });
  assert.deepEqual(jira.health(), { state: 'ok', message: null, checkedAt: T1.toISOString(), polling: false });
  assert.equal((await store.read()).directions[0].tickets[0].jira?.status, 'Open');
});

test('refresh asks only for keys of unfinished directions', async t => {
  const store = await tempStore(t);
  await store.createDirection({ title: 'SEO', ticketKeys: ['APP-1'] });
  await store.createDirection({ title: 'Готово', status: 'done', ticketKeys: ['APP-2'] });
  const asked: string[][] = [];
  const jira = poller(t, store, async keys => {
    asked.push([...keys]);
    return [];
  });

  await jira.refresh();

  assert.deepEqual(asked, [['APP-1']]);
});

test('refresh with no tickets asks nothing and reports ok', async t => {
  let calls = 0;
  const jira = poller(t, await tempStore(t), async () => {
    calls++;
    return [];
  });

  assert.equal((await jira.refresh()).state, 'ok');
  assert.equal(calls, 0);
});

test('a failed poll keeps statuses and the last good time', async t => {
  const store = await tempStore(t);
  await store.createDirection({ title: 'SEO', ticketKeys: ['APP-1'] });
  const answers: (() => JiraIssue[])[] = [
    () => [issue('APP-1', 'Open')],
    () => {
      throw new JiraError('истёк или неверный токен');
    },
    () => [issue('APP-1', 'Open')],
  ];
  const times = [T1, T2, T3];
  let call = 0;
  const jira = poller(t, store, async () => answers[call++](), { now: () => times[call - 1] ?? T3 });

  await jira.refresh();
  assert.deepEqual(await jira.refresh(), { state: 'error', message: 'истёк или неверный токен', checkedAt: T1.toISOString(), polling: false });
  const saved = (await store.read()).directions[0];
  assert.equal(saved.tickets[0].jira?.status, 'Open');
  assert.deepEqual(saved.events, []);

  assert.equal((await jira.refresh()).state, 'ok');
});

test('an unexpected error becomes its message', async t => {
  const store = await tempStore(t);
  await store.createDirection({ title: 'SEO', ticketKeys: ['APP-1'] });
  const jira = poller(t, store, async () => {
    throw new Error('boom');
  });

  assert.deepEqual(await jira.refresh(), { state: 'error', message: 'boom', checkedAt: null, polling: false });
});

test('concurrent refreshes share one poll', async t => {
  const store = await tempStore(t);
  await store.createDirection({ title: 'SEO', ticketKeys: ['APP-1'] });
  let calls = 0;
  let release = (): void => {};
  const jira = poller(t, store, async () => {
    calls++;
    await new Promise<void>(resolve => (release = resolve));
    return [issue('APP-1', 'Open')];
  });

  const first = jira.refresh();
  const second = jira.refresh();
  await sleep(50);
  assert.equal(jira.health().polling, true);
  release();

  assert.deepEqual(await first, await second);
  assert.equal(calls, 1);
});

test('not configured is off with the reason', async t => {
  const jira = poller(t, await tempStore(t), 'нет сертификата ~/.config/worklog/jira.p12');

  assert.deepEqual(await jira.refresh(), { state: 'off', message: 'нет сертификата ~/.config/worklog/jira.p12', checkedAt: null, polling: false });
  assert.deepEqual(jira.health(), await jira.refresh());
});

test('setup finished while running: the next refresh connects and polls', async t => {
  const store = await tempStore(t);
  await store.createDirection({ title: 'SEO', ticketKeys: ['APP-1'] });
  const clients: (JiraFetch | string)[] = ['нет пароля от сертификата в связке ключей (worklog-jira-p12)', async () => [issue('APP-1', 'Open')]];
  const jira = connecting(t, store, async () => clients.shift() ?? 'нет клиента');

  assert.equal((await jira.refresh()).state, 'off');
  assert.equal((await jira.refresh()).state, 'ok');
  assert.equal((await store.read()).directions[0].tickets[0].jira?.status, 'Open');
});

test('after an error the client is built again, so a replaced token is read', async t => {
  const store = await tempStore(t);
  await store.createDirection({ title: 'SEO', ticketKeys: ['APP-1'] });
  let connects = 0;
  const expired: JiraFetch = async () => {
    throw new JiraError('истёк или неверный токен');
  };
  const renewed: JiraFetch = async () => [issue('APP-1', 'Open')];
  const jira = connecting(t, store, async () => (++connects === 1 ? expired : renewed));

  assert.equal((await jira.refresh()).state, 'error');
  assert.equal((await jira.refresh()).state, 'ok');
  assert.equal(connects, 2);
});

test('a working client is kept between polls', async t => {
  const store = await tempStore(t);
  await store.createDirection({ title: 'SEO', ticketKeys: ['APP-1'] });
  let connects = 0;
  const jira = connecting(t, store, async () => {
    connects++;
    return async () => [issue('APP-1', 'Open')];
  });

  await jira.refresh();
  await jira.refresh();
  assert.equal(connects, 1);
});

test('a failing connect is an error, tried again next time', async t => {
  let connects = 0;
  const jira = connecting(t, await tempStore(t), async () => {
    connects++;
    throw new Error('EACCES: permission denied');
  });

  assert.deepEqual(await jira.refresh(), { state: 'error', message: 'EACCES: permission denied', checkedAt: null, polling: false });
  await jira.refresh();
  assert.equal(connects, 2);
});

test('onHealth fires when health changes', async t => {
  const store = await tempStore(t);
  await store.createDirection({ title: 'SEO', ticketKeys: ['APP-1'] });
  const fails = [false, false, true, false];
  let call = 0;
  let fired = 0;
  const jira = poller(
    t,
    store,
    async () => {
      if (fails[call++]) throw new JiraError('нет связи');
      return [issue('APP-1', 'Open')];
    },
    { onHealth: () => fired++ },
  );

  await jira.refresh();
  const afterFirst = fired;
  await jira.refresh();
  assert.equal(fired, afterFirst, 'ok → ok');
  await jira.refresh();
  assert.equal(fired, afterFirst + 1, 'ok → error');
  await jira.refresh();
  assert.equal(fired, afterFirst + 2, 'error → ok');
});

test('polls on the timer once started, stops on close', async t => {
  const store = await tempStore(t);
  await store.createDirection({ title: 'SEO', ticketKeys: ['APP-1'] });
  let calls = 0;
  const jira = poller(
    t,
    store,
    async () => {
      calls++;
      return [];
    },
    { pollMs: 20 },
  );
  await sleep(60);
  assert.equal(calls, 0, 'nothing before start');

  jira.start();
  await sleep(120);
  assert.ok(calls >= 2, `polled ${calls} times`);

  jira.close();
  const stopped = calls;
  await sleep(80);
  assert.equal(calls, stopped);
});
