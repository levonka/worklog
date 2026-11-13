import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LsRemote } from './merge-requests.ts';
import { findMergeRequests, linkMergeRequests, matchMergeRequests } from './merge-requests.ts';
import { Store } from './store.ts';
import { TEST_PROFILE } from '../shared/test-profile.ts';

const SEO = 'feature/APP-7301_WEB-4410';
const HEAD = '53b1208297ea7a189d5e2a2db76c083043f0a77d';
const OTHER = '1111111111111111111111111111111111111111';

const OUTPUT = [
  `${HEAD}\trefs/heads/${SEO}`,
  `${OTHER}\trefs/heads/feature/APP-2715`,
  `${OTHER}\trefs/merge-requests/3001/head`,
  `${HEAD}\trefs/merge-requests/2990/head`,
  `${HEAD}\trefs/merge-requests/3015/head`,
  '',
].join('\n');

test('matchMergeRequests takes the newest MR whose head is the branch head', () => {
  assert.deepEqual(matchMergeRequests(OUTPUT, [SEO, 'feature/APP-2715', 'feature/APP-404']), new Map([
    [SEO, 3015],
    ['feature/APP-2715', 3001],
  ]));
});

test('findMergeRequests asks git only about the branches and MR heads', async () => {
  const asked: string[][] = [];
  const lsRemote: LsRemote = async (_root, patterns) => {
    asked.push([...patterns]);
    return OUTPUT;
  };

  assert.deepEqual(await findMergeRequests('/code', [SEO], lsRemote), new Map([[SEO, 3015]]));
  assert.deepEqual(asked, [[`refs/heads/${SEO}`, 'refs/merge-requests/*/head']]);
  assert.deepEqual(await findMergeRequests('/code', [], lsRemote), new Map());
  assert.equal(asked.length, 1);
});

async function tempStore(t: TestContext): Promise<Store> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-mr-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new Store(dir, { profile: TEST_PROFILE });
}

test('linkMergeRequests links the MRs of unfinished directions', async t => {
  const store = await tempStore(t);
  await store.createDirection({ title: 'SEO', ticketKeys: ['APP-7301', 'WEB-4410'] });
  await store.createDirection({ title: 'Без ветки', ticketKeys: ['CRM-1'] });
  const asked: string[][] = [];

  await linkMergeRequests(store, '/code', async (_root, patterns) => {
    asked.push([...patterns]);
    return OUTPUT;
  });

  assert.deepEqual(asked, [[`refs/heads/${SEO}`, 'refs/merge-requests/*/head']]);
  assert.equal((await store.read()).directions.find(d => d.title === 'SEO')?.links[0].title, 'MR !3015');
});

test('linkMergeRequests stays quiet when git fails', async t => {
  const store = await tempStore(t);
  await store.createDirection({ title: 'SEO', ticketKeys: ['APP-7301'] });

  await linkMergeRequests(store, '/code', async () => {
    throw new Error('ssh: connect to host git.example.com port 7996: Operation timed out');
  });

  assert.deepEqual((await store.read()).directions[0].links, []);
});

test('linkMergeRequests looks no branch up for the example', async t => {
  const store = await tempStore(t);
  await store.seedExample();
  const asked: string[][] = [];

  await linkMergeRequests(store, '/code', async (_root, patterns) => {
    asked.push([...patterns]);
    return OUTPUT;
  });

  assert.deepEqual(asked, []);
});
