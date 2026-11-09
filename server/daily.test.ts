import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Direction } from '../shared/model.ts';
import { ticketFromKey } from '../shared/model.ts';
import { startSummary } from './daily.ts';
import type { SummaryConfig } from './daily.ts';
import { Store } from './store.ts';
import { TEST_PROFILE } from '../shared/test-profile.ts';

// Thursday 5 November 2026 at noon; the period starts on Wednesday at 11:30
const NOW = new Date(2026, 10, 5, 12);
const PERIOD = new Date(2026, 10, 4, 11, 30).toISOString();
const IN_PERIOD = new Date(2026, 10, 5, 10).toISOString();

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function direction(): Direction {
  return { id: 'seo', title: 'SEO', status: 'in_progress', tickets: [ticketFromKey('APP-9355', TEST_PROFILE)], links: [], events: [], order: 0, createdAt: PERIOD, updatedAt: PERIOD };
}

async function writeTranscript(projectsDir: string): Promise<void> {
  await mkdir(path.join(projectsDir, 'p'), { recursive: true });
  const record = { type: 'user', timestamp: IN_PERIOD, sessionId: 's1', cwd: '/m', gitBranch: 'feature/APP-9355', message: { role: 'user', content: 'почини сео' } };
  await writeFile(path.join(projectsDir, 'p', 's1.jsonl'), `${JSON.stringify(record)}\n`);
}

const ANSWER = {
  type: 'result',
  is_error: false,
  structured_output: {
    sessions: [{ sessionId: 's1', directionId: 'seo', items: ['выяснил, что бэк не отдаёт SEO-текст'] }],
    todoCandidates: [{ sessionId: 's1', text: 'Завести задачу бэку', requestedBy: 'Олега', directionId: 'seo' }],
    prose: 'Касаемо задачи по сео - выяснил, что бэк не отдаёт текст.',
  },
};

async function setup(t: TestContext, stubBody: string): Promise<{ store: Store; config: SummaryConfig; stubDir: string; projectsDir: string }> {
  const dataDir = await tempDir(t, 'worklog-daily-data-');
  const projectsDir = await tempDir(t, 'worklog-daily-projects-');
  const stubDir = await tempDir(t, 'worklog-daily-claude-');
  const bin = path.join(stubDir, 'claude');
  await writeFile(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = path.dirname(process.argv[1]);
fs.writeFileSync(path.join(dir, 'called'), '');
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => { ${stubBody} });
`,
  );
  await chmod(bin, 0o755);
  await writeTranscript(projectsDir);
  const store = new Store(dataDir, { profile: TEST_PROFILE });
  await store.mutate(s => {
    s.directions.push(direction());
  });
  return { store, config: { claudeProjectsDir: projectsDir, agent: { agent: 'claude', bin, model: 'sonnet', cwd: tmpdir(), timeoutMs: 5000 } }, stubDir, projectsDir };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

test('startSummary stores items, candidates and prose; text follows prose', async t => {
  const { store, config } = await setup(t, `process.stdout.write(${JSON.stringify(JSON.stringify(ANSWER))});`);
  const { done } = await startSummary(store, config, () => NOW);
  assert.equal((await store.read()).draft?.run?.status, 'running');
  await done;
  const draft = (await store.read()).draft;
  assert.equal(draft?.run, null);
  assert.equal(draft?.text, 'Касаемо задачи по сео - выяснил, что бэк не отдаёт текст.');
  assert.deepEqual(draft?.summary?.items.map(i => [i.directionId, i.text, i.at]), [['seo', 'выяснил, что бэк не отдаёт SEO-текст', IN_PERIOD]]);
  assert.deepEqual(draft?.summary?.candidates.map(c => [c.text, c.requestedBy]), [['Завести задачу бэку', 'Олега']]);
  assert.equal(draft?.summary?.sessionCount, 1);
});

test('no sessions → no claude call, sessionCount 0, text unchanged', async t => {
  const { store, config, stubDir, projectsDir } = await setup(t, `process.stdout.write('{}');`);
  await rm(projectsDir, { recursive: true });
  await store.setDraftText(PERIOD, 'моё', NOW);
  const { done } = await startSummary(store, config, () => NOW);
  await done;
  const draft = (await store.read()).draft;
  assert.equal(await exists(path.join(stubDir, 'called')), false);
  assert.equal(draft?.summary?.sessionCount, 0);
  assert.equal(draft?.text, 'моё');
  assert.equal(draft?.run, null);
});

test('claude failure → run failed with message, next start allowed', async t => {
  const { store, config } = await setup(t, `process.stderr.write('Не авторизован\\n'); process.exit(1);`);
  const first = await startSummary(store, config, () => NOW);
  await first.done;
  assert.deepEqual((await store.read()).draft?.run, { status: 'failed', at: NOW.toISOString(), error: 'claude завершился с кодом 1: Не авторизован' });
  const second = await startSummary(store, config, () => NOW);
  await second.done;
});

test('period changed while running → result dropped', async t => {
  const { store, config, stubDir } = await setup(
    t,
    `const wait = () => fs.existsSync(path.join(dir, 'go')) ? process.stdout.write(${JSON.stringify(JSON.stringify(ANSWER))}) : setTimeout(wait, 20); wait();`,
  );
  const { done } = await startSummary(store, config, () => NOW);
  while (!(await exists(path.join(stubDir, 'called')))) await sleep(20);
  await store.holdDaily({ periodStart: PERIOD, text: 'Дейлик' }, NOW);
  await writeFile(path.join(stubDir, 'go'), '');
  await done;
  const state = await store.read();
  assert.equal(state.draft, null);
  assert.equal(state.dailies.length, 1);
});

test('the daily summary merges Claude and Codex sessions by time', async t => {
  const { store, config, stubDir } = await setup(t, `fs.writeFileSync(path.join(dir, 'stdin.txt'), input); process.stdout.write(${JSON.stringify(JSON.stringify(ANSWER))});`);
  const codexDir = await tempDir(t, 'worklog-daily-codex-');
  const day = path.join(codexDir, '2026', '03', '02');
  await mkdir(day, { recursive: true });
  const earlier = new Date(new Date(IN_PERIOD).getTime() - 60_000).toISOString();
  const lines = [
    { timestamp: earlier, type: 'session_meta', payload: { id: 'c1', cwd: '/m' } },
    { timestamp: earlier, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'разбери логи редиректа' }] } },
  ];
  await writeFile(path.join(day, 'rollout-c1.jsonl'), `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  const { done } = await startSummary(store, { ...config, codexSessionsDir: codexDir }, () => NOW);
  await done;
  const prompt = await readFile(path.join(stubDir, 'stdin.txt'), 'utf8');
  assert.ok(prompt.indexOf('разбери логи редиректа') > -1 && prompt.indexOf('разбери логи редиректа') < prompt.indexOf('почини сео'));
  assert.equal((await store.read()).draft?.summary?.sessionCount, 2);
});
