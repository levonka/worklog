import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { currentPeriodStart } from '../shared/model.ts';
import { History } from './history.ts';
import { Store } from './store.ts';

async function setup(t: TestContext): Promise<{ store: Store; history: History; dataDir: string }> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'worklog-history-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const history = new History();
  const store = new Store(dataDir, { onCommit: changes => history.record(changes) });
  return { store, history, dataDir };
}

test('undo reverts a tracked change and redo applies it again', async t => {
  const { store, history } = await setup(t);
  const direction = await history.track(() => store.createDirection({ title: 'Сео' }));
  await history.track(() => store.renameDirection(direction.id, 'SEO-текст'));

  assert.equal(await history.undo(store), 'applied');
  assert.equal((await store.read()).directions[0].title, 'Сео');

  assert.equal(await history.redo(store), 'applied');
  assert.equal((await store.read()).directions[0].title, 'SEO-текст');
});

test('undo of a delete brings the direction back with its events and todo link', async t => {
  const { store, history } = await setup(t);
  const direction = await store.createDirection({ title: 'Пуши' });
  await store.addEvent(direction.id, 'Начал', 'manual');
  await store.addTodo({ text: 'Спросить бэк', directionId: direction.id });
  const before = await store.read();

  await history.track(() => store.deleteDirection(direction.id));
  assert.equal(await history.undo(store), 'applied');

  assert.deepEqual(await store.read(), before);
});

test('undo of a status change also removes its system event', async t => {
  const { store, history } = await setup(t);
  const direction = await store.createDirection({ title: 'Пуши' });
  const before = await store.read();

  await history.track(() => store.setStatus(direction.id, 'testing'));
  await history.undo(store);

  assert.deepEqual(await store.read(), before);
});

test('restored files keep the usual on-disk format', async t => {
  const { store, history, dataDir } = await setup(t);
  await store.addTodo({ text: 'Первое' });
  const file = path.join(dataDir, 'todos.json');
  const original = await readFile(file, 'utf8');

  await history.track(() => store.addTodo({ text: 'Второе' }));
  await history.undo(store);

  assert.equal(await readFile(file, 'utf8'), original);
});

test('changes outside track are not recorded', async t => {
  const { store, history } = await setup(t);
  await store.createDirection({ title: 'Из CLI' });

  assert.equal(await history.undo(store), 'empty');
  assert.equal((await store.read()).directions.length, 1);
});

test('several mutations inside one track form one step', async t => {
  const { store, history } = await setup(t);
  const todo = await store.addTodo({ text: 'Дело' });

  await history.track(async () => {
    await store.updateTodo(todo.id, { text: 'Дело поправлено' });
    await store.setTodoDone(todo.id, true);
  });
  await history.undo(store);

  const [restored] = (await store.read()).todos;
  assert.equal(restored.text, 'Дело');
  assert.equal(restored.done, false);
  assert.equal(await history.undo(store), 'empty');
});

test('a step is recorded even when the request fails after a mutation', async t => {
  const { store, history } = await setup(t);
  const todo = await store.addTodo({ text: 'Дело' });

  await assert.rejects(
    history.track(async () => {
      await store.updateTodo(todo.id, { text: 'Новое' });
      await store.setTodoDone('missing', true);
    }),
  );

  assert.equal(await history.undo(store), 'applied');
  assert.equal((await store.read()).todos[0].text, 'Дело');
});

test('a track without changes leaves the history alone', async t => {
  const { store, history } = await setup(t);
  await history.track(() => store.createDirection({ title: 'Сео' }));
  await history.track(() => store.read());

  assert.equal(await history.undo(store), 'applied');
  assert.deepEqual((await store.read()).directions, []);
  assert.equal(await history.undo(store), 'empty');
});

test('undo refuses when the files changed since, and drops that step', async t => {
  const { store, history } = await setup(t);
  const direction = await history.track(() => store.createDirection({ title: 'Сео' }));
  await history.track(() => store.renameDirection(direction.id, 'Окно'));
  await store.renameDirection(direction.id, 'Из CLI');

  assert.equal(await history.undo(store), 'conflict');
  assert.equal((await store.read()).directions[0].title, 'Из CLI');
  assert.equal(await history.redo(store), 'empty');
});

test('undo of an older step still works when only other files changed since', async t => {
  const { store, history } = await setup(t);
  const direction = await store.createDirection({ title: 'Сео' });
  await history.track(() => store.renameDirection(direction.id, 'SEO'));
  await store.addTodo({ text: 'Из CLI' });

  assert.equal(await history.undo(store), 'applied');
  const state = await store.read();
  assert.equal(state.directions[0].title, 'Сео');
  assert.equal(state.todos.length, 1);
});

test('a new tracked change clears redo', async t => {
  const { store, history } = await setup(t);
  await history.track(() => store.addTodo({ text: 'Первое' }));
  await history.undo(store);
  await history.track(() => store.addTodo({ text: 'Второе' }));

  assert.equal(await history.redo(store), 'empty');
  assert.deepEqual((await store.read()).todos.map(todo => todo.text), ['Второе']);
});

test('concurrent undos apply in reverse order of the changes', async t => {
  const { store, history } = await setup(t);
  const todo = await store.addTodo({ text: 'v0' });
  await history.track(() => store.updateTodo(todo.id, { text: 'v1' }));
  await history.track(() => store.updateTodo(todo.id, { text: 'v2' }));

  assert.deepEqual(await Promise.all([history.undo(store), history.undo(store)]), ['applied', 'applied']);
  assert.equal((await store.read()).todos[0].text, 'v0');
});

test('history keeps only the latest 100 steps', async t => {
  const { store, history } = await setup(t);
  const todo = await store.addTodo({ text: 'v0' });
  for (let i = 1; i <= 101; i++) await history.track(() => store.updateTodo(todo.id, { text: `v${i}` }));

  let undone = 0;
  while ((await history.undo(store)) === 'applied') undone++;

  assert.equal(undone, 100);
  assert.equal((await store.read()).todos[0].text, 'v1');
});

test('consecutive saves with one merge key are one undo step', async t => {
  const { store, history } = await setup(t);
  const period = currentPeriodStart(new Date(), []);
  await history.track(() => store.createDirection({ title: 'Сео' }));
  await history.track(() => store.setDraftText(period, 'раз'), 'daily-text');
  await history.track(() => store.setDraftText(period, 'раз два'), 'daily-text');
  await history.track(() => store.setDraftText(period, 'раз два три'), 'daily-text');

  assert.equal(await history.undo(store), 'applied');
  const state = await store.read();
  assert.equal(state.draft, null);
  assert.equal(state.directions.length, 1);

  assert.equal(await history.redo(store), 'applied');
  assert.equal((await store.read()).draft?.text, 'раз два три');
});

test('a change in between splits text saves into two steps', async t => {
  const { store, history } = await setup(t);
  const period = currentPeriodStart(new Date(), []);
  await history.track(() => store.setDraftText(period, 'раз'), 'daily-text');
  await history.track(() => store.createDirection({ title: 'Сео' }));
  await history.track(() => store.setDraftText(period, 'раз два'), 'daily-text');
  await history.undo(store);
  assert.equal((await store.read()).draft?.text, 'раз');
});
