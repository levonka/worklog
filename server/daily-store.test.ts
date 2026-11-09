import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DailyDraft, Direction, SessionSummary } from '../shared/model.ts';
import { ConflictError, NotFoundError, Store, ValidationError } from './store.ts';

// 5 November 2026 is a Thursday; its period starts on Wednesday at 11:30
const at = (day: number, hour: number, minute = 0): Date => new Date(2026, 10, day, hour, minute);
const iso = (day: number, hour: number, minute = 0): string => at(day, hour, minute).toISOString();
const NOW = at(5, 12);
const PERIOD = iso(4, 11, 30);

async function tempStore(t: TestContext): Promise<{ store: Store; dataDir: string }> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'worklog-daily-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { store: new Store(dataDir), dataDir };
}

function direction(id: string, title = id): Direction {
  return { id, title, status: 'in_progress', tickets: [], links: [], events: [], order: 0, createdAt: iso(1, 9), updatedAt: iso(1, 9) };
}

function summary(patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    ranAt: iso(5, 11),
    sessionCount: 2,
    items: [
      { id: 'i1', sessionId: 's1', at: iso(5, 10), directionId: 'a', text: 'разобрал сторы' },
      { id: 'i2', sessionId: 's2', at: iso(5, 10, 30), directionId: null, text: 'придумывал worklog' },
    ],
    candidates: [{ id: 'c1', sessionId: 's1', text: 'Завести задачу бэку', requestedBy: 'Олега', directionId: 'a' }],
    ...patch,
  };
}

function draft(patch: Partial<DailyDraft> = {}): DailyDraft {
  return { periodStart: PERIOD, text: null, textAt: null, summary: summary(), run: null, ...patch };
}

async function seed(store: Store, value: DailyDraft | null, directions: Direction[] = [direction('a', 'Сторы')]): Promise<void> {
  await store.mutate(s => {
    s.directions.push(...directions);
    s.draft = value;
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

test('holdDaily writes daily file, removes draft and adds session-summary events', async t => {
  const { store, dataDir } = await tempStore(t);
  await seed(store, draft());
  const daily = await store.holdDaily({ periodStart: PERIOD, text: 'Текст дейлика' }, NOW);

  assert.equal(daily.heldAt, NOW.toISOString());
  assert.equal(daily.periodStart, PERIOD);
  assert.equal(await exists(path.join(dataDir, 'daily-draft.json')), false);
  assert.deepEqual(await readdir(path.join(dataDir, 'dailies')), [`${daily.id}.json`]);
  const state = await store.read();
  assert.equal(state.draft, null);
  assert.deepEqual(state.dailies, [daily]);
  const [added] = state.directions[0].events;
  assert.deepEqual({ at: added.at, text: added.text, source: added.source, kind: added.kind }, { at: iso(5, 10), text: 'разобрал сторы', source: 'session-summary', kind: 'note' });
});

test('unbound summary items stay only in the daily record', async t => {
  const { store } = await tempStore(t);
  await seed(store, draft());
  const daily = await store.holdDaily({ periodStart: PERIOD, text: 'x' }, NOW);
  assert.deepEqual(
    daily.items.map(i => [i.directionId, i.text, i.origin]),
    [
      ['a', 'разобрал сторы', 'summary'],
      [null, 'придумывал worklog', 'summary'],
    ],
  );
  const state = await store.read();
  assert.equal(state.directions[0].events.length, 1);
});

test('second holdDaily with the same periodStart is rejected', async t => {
  const { store } = await tempStore(t);
  await seed(store, null);
  await store.holdDaily({ periodStart: PERIOD, text: 'x' }, NOW);
  await assert.rejects(store.holdDaily({ periodStart: PERIOD, text: 'x' }, at(5, 12, 1)), ValidationError);
  assert.equal((await store.read()).dailies.length, 1);
});

test('holdDaily needs a text', async t => {
  const { store } = await tempStore(t);
  await assert.rejects(store.holdDaily({ periodStart: PERIOD, text: '  ' }, NOW), ValidationError);
});

test('deleted direction turns items unbound', async t => {
  const { store } = await tempStore(t);
  await seed(store, draft());
  await store.deleteDirection('a');
  const todo = await store.acceptCandidate('c1', NOW);
  assert.equal(todo.directionId, undefined);
  const daily = await store.holdDaily({ periodStart: PERIOD, text: 'x' }, NOW);
  assert.deepEqual(
    daily.items.map(i => i.directionId),
    [null, null],
  );
});

test('setDraftText with an old periodStart is rejected', async t => {
  const { store } = await tempStore(t);
  await assert.rejects(store.setDraftText(iso(3, 11, 30), 'x', NOW), ValidationError);
});

test('setDraftText starts a draft of the current period over an old one', async t => {
  const { store } = await tempStore(t);
  await seed(store, draft({ periodStart: iso(3, 11, 30), text: 'старый' }));
  const saved = await store.setDraftText(PERIOD, 'новый', NOW);
  assert.deepEqual(saved, { periodStart: PERIOD, text: 'новый', textAt: NOW.toISOString(), summary: null, run: null });
  const back = await store.setDraftText(PERIOD, null, NOW);
  assert.equal(back.text, null);
  assert.equal(back.textAt, null);
});

test('acceptCandidate adds todo first and removes the candidate', async t => {
  const { store } = await tempStore(t);
  await seed(store, draft());
  await store.addTodo({ text: 'старое' });
  const todo = await store.acceptCandidate('c1', NOW);
  assert.deepEqual({ text: todo.text, requestedBy: todo.requestedBy, directionId: todo.directionId }, { text: 'Завести задачу бэку', requestedBy: 'Олега', directionId: 'a' });
  const state = await store.read();
  assert.equal(state.todos[0].id, todo.id);
  assert.deepEqual(state.draft?.summary?.candidates, []);
  await assert.rejects(store.acceptCandidate('c1', NOW), NotFoundError);
});

test('dismissCandidate and removeSummaryItem drop entries; rebinding checks the direction', async t => {
  const { store } = await tempStore(t);
  await seed(store, draft());
  await store.dismissCandidate('c1', NOW);
  await store.removeSummaryItem('i1', NOW);
  const moved = await store.setSummaryItemDirection('i2', 'a', NOW);
  assert.equal(moved.directionId, 'a');
  await assert.rejects(store.setSummaryItemDirection('i2', 'gone', NOW), NotFoundError);
  const summaryState = (await store.read()).draft?.summary;
  assert.deepEqual(summaryState?.candidates, []);
  assert.deepEqual(summaryState?.items.map(i => [i.id, i.directionId]), [['i2', 'a']]);
});

test('beginSummaryRun twice is ConflictError; stale running is not', async t => {
  const { store } = await tempStore(t);
  assert.deepEqual(await store.beginSummaryRun(NOW), { periodStart: PERIOD });
  await assert.rejects(store.beginSummaryRun(at(5, 12, 1)), ConflictError);
  await store.beginSummaryRun(at(5, 12, 7));
  assert.deepEqual((await store.read()).draft?.run, { status: 'running', startedAt: at(5, 12, 7).toISOString(), baseTextAt: null });
});

test('finishSummaryRun stores the summary and the prose', async t => {
  const { store } = await tempStore(t);
  await store.beginSummaryRun(NOW);
  await store.finishSummaryRun(PERIOD, { summary: summary(), prose: 'Касаемо задачи по сторам' }, NOW);
  const saved = (await store.read()).draft;
  assert.equal(saved?.run, null);
  assert.equal(saved?.text, 'Касаемо задачи по сторам');
  assert.equal(saved?.textAt, summary().ranAt);
  await store.beginSummaryRun(NOW);
  await store.finishSummaryRun(PERIOD, { error: 'claude упал' }, NOW);
  assert.deepEqual((await store.read()).draft?.run, { status: 'failed', at: NOW.toISOString(), error: 'claude упал' });
});

test('finishSummaryRun for another period changes nothing', async t => {
  const { store } = await tempStore(t);
  await store.beginSummaryRun(NOW);
  await store.finishSummaryRun(iso(3, 11, 30), { summary: summary(), prose: 'x' }, NOW);
  assert.deepEqual((await store.read()).draft?.run, { status: 'running', startedAt: NOW.toISOString(), baseTextAt: null });
});

test('corrupt daily file raises error naming the file', async t => {
  const { store, dataDir } = await tempStore(t);
  await mkdir(path.join(dataDir, 'dailies'));
  await writeFile(path.join(dataDir, 'dailies', 'x.json'), '{');
  await assert.rejects(store.read(), /dailies\/x\.json/);
  await writeFile(path.join(dataDir, 'daily-draft.json'), '{"periodStart":1}');
  await rm(path.join(dataDir, 'dailies'), { recursive: true });
  await assert.rejects(store.read(), /daily-draft\.json/);
});

test('finishSummaryRun keeps text edited while the run was going', async t => {
  const { store } = await tempStore(t);
  await store.setDraftText(PERIOD, 'до сборки', NOW);
  await store.beginSummaryRun(NOW);
  await store.setDraftText(PERIOD, 'правлю во время сборки', at(5, 12, 1));
  await store.finishSummaryRun(PERIOD, { summary: summary(), prose: 'проза' }, at(5, 12, 2));
  const saved = (await store.read()).draft;
  assert.equal(saved?.text, 'правлю во время сборки');
  assert.equal(saved?.summary?.sessionCount, 2);
  assert.equal(saved?.run, null);
});

test('a run of the previous period still going blocks a new one after midnight', async t => {
  const { store } = await tempStore(t);
  await store.beginSummaryRun(at(5, 23, 58));
  await assert.rejects(store.beginSummaryRun(at(6, 0, 1)), ConflictError);
});

test('abandonSummaryRun marks a running run as failed and leaves others alone', async t => {
  const { store } = await tempStore(t);
  await store.abandonSummaryRun(NOW);
  assert.equal((await store.read()).draft, null);
  await store.beginSummaryRun(NOW);
  await store.abandonSummaryRun(at(5, 12, 1));
  assert.deepEqual((await store.read()).draft?.run, { status: 'failed', at: at(5, 12, 1).toISOString(), error: 'сборка прервалась: сервер перезапускался' });
});
