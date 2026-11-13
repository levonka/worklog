import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NotFoundError, Store, ValidationError, newId } from './store.ts';
import { TEST_PROFILE } from '../shared/test-profile.ts';

async function tempStore(t: TestContext): Promise<Store> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-domain-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new Store(dir, { profile: TEST_PROFILE });
}

test('newId returns time-sortable base36 ids that differ', () => {
  const a = newId();
  const b = newId();
  assert.match(a, /^[0-9a-z]+$/);
  assert.ok(a.length >= 4 + 8);
  assert.notEqual(a, b);
});

test('newId joins base36 time and four random digits', () => {
  assert.equal(newId(1_700_000_000_000, () => 10), 'loyw3v28aaaa');
  assert.equal(newId(0, () => 35), '0zzzz');
  assert.ok(newId(1_700_000_000_000, () => 35) < newId(1_700_000_000_001, () => 0));
});

test('createDirection defaults to in_progress and goes to the end of the column', async t => {
  const store = await tempStore(t);
  const first = await store.createDirection({ title: 'Первое' });
  const second = await store.createDirection({ title: 'Второе' });
  const other = await store.createDirection({ title: 'Жду', status: 'waiting', waitingFor: 'девопсы' });
  assert.equal(first.status, 'in_progress');
  assert.equal(first.order, 0);
  assert.equal(second.order, 1);
  assert.equal(other.order, 0);
  assert.equal(other.waitingFor, 'девопсы');
  assert.deepEqual(first.events, []);
  const state = await store.read();
  const column = (status: string): [string, number][] =>
    state.directions
      .filter(d => d.status === status)
      .sort((x, y) => x.order - y.order)
      .map(d => [d.title, d.order]);
  assert.deepEqual(column('in_progress'), [
    ['Первое', 0],
    ['Второе', 1],
  ]);
  assert.deepEqual(column('waiting'), [['Жду', 0]]);
});

test('createDirection ignores waitingFor unless the status is waiting', async t => {
  const store = await tempStore(t);
  const created = await store.createDirection({ title: 'Д', status: 'testing', waitingFor: 'девопсы' });
  assert.equal('waitingFor' in created, false);
  assert.equal('waitingFor' in (await store.read()).directions[0], false);
});

test('createDirection normalizes ticket keys and rejects invalid ones', async t => {
  const store = await tempStore(t);
  const created = await store.createDirection({ title: 'Фильтры', ticketKeys: ['app-7301', 'WEB-4410', 'APP-7301'] });
  assert.deepEqual(
    created.tickets.map(ticket => [ticket.key, ticket.platform]),
    [
      ['APP-7301', 'App'],
      ['WEB-4410', 'Web'],
    ],
  );
  await assert.rejects(store.createDirection({ title: 'X', ticketKeys: ['не ключ'] }), ValidationError);
  await assert.rejects(store.createDirection({ title: '  ' }), ValidationError);
  assert.equal((await store.read()).directions.length, 1);
});

test('renameDirection changes the title and validates it', async t => {
  const store = await tempStore(t);
  const created = await store.createDirection({ title: 'Старое' });
  const renamed = await store.renameDirection(created.id, ' Новое ');
  assert.equal(renamed.title, 'Новое');
  assert.equal((await store.read()).directions[0].title, 'Новое');
  await assert.rejects(store.renameDirection(created.id, ''), ValidationError);
  await assert.rejects(store.renameDirection('nope', 'X'), NotFoundError);
});

test('setStatus to waiting with waitingFor writes event "Статус: Жду · девопсы"', async t => {
  const store = await tempStore(t);
  const created = await store.createDirection({ title: 'Д' });
  const updated = await store.setStatus(created.id, 'waiting', { waitingFor: 'девопсы' });
  assert.equal(updated.status, 'waiting');
  assert.equal(updated.waitingFor, 'девопсы');
  const [event] = updated.events;
  assert.equal(event.text, 'Статус: Жду · девопсы');
  assert.equal(event.kind, 'status');
  assert.equal(event.source, 'system');
  assert.equal(updated.events.length, 1);
  assert.deepEqual((await store.read()).directions[0], updated);
});

test('setStatus writes plain label event and skips the event when status is unchanged', async t => {
  const store = await tempStore(t);
  const created = await store.createDirection({ title: 'Д' });
  const tested = await store.setStatus(created.id, 'testing');
  assert.equal(tested.events[0].text, 'Статус: Тестирование');
  const again = await store.setStatus(created.id, 'testing');
  assert.equal(again.events.length, 1);
});

test('setStatus to done stamps doneAt, leaving done clears it, done again restamps', async t => {
  const store = await tempStore(t);
  const created = await store.createDirection({ title: 'Д' });
  const before = new Date().toISOString();
  const done = await store.setStatus(created.id, 'done');
  assert.ok(done.doneAt !== undefined && done.doneAt >= before && !Number.isNaN(Date.parse(done.doneAt)));
  const back = await store.setStatus(created.id, 'in_progress');
  assert.equal('doneAt' in back, false);
  const again = await store.setStatus(created.id, 'done');
  assert.ok(again.doneAt !== undefined && again.doneAt >= done.doneAt);
  assert.equal(again.events.length, 3);
  assert.deepEqual((await store.read()).directions[0], again);
});

test('setStatus done → done keeps doneAt', async t => {
  const store = await tempStore(t);
  const created = await store.createDirection({ title: 'Д' });
  const done = await store.setStatus(created.id, 'done');
  await store.setDoneDate(created.id, '2026-10-01');
  const stamped = (await store.read()).directions[0].doneAt;
  const again = await store.setStatus(created.id, 'done');
  assert.notEqual(stamped, done.doneAt);
  assert.equal(again.doneAt, stamped);
});

test('createDirection with status done stamps doneAt; other statuses do not', async t => {
  const store = await tempStore(t);
  const done = await store.createDirection({ title: 'Готовое', status: 'done' });
  const working = await store.createDirection({ title: 'В работе' });
  assert.ok(done.doneAt !== undefined && !Number.isNaN(Date.parse(done.doneAt)));
  assert.equal('doneAt' in working, false);
  assert.equal(done.events.length, 0);
});

test('setDoneDate stores local noon of the day and writes no event', async t => {
  const store = await tempStore(t);
  const created = await store.createDirection({ title: 'Д' });
  const done = await store.setStatus(created.id, 'done');
  const updated = await store.setDoneDate(created.id, '2026-10-01');
  assert.ok(updated.doneAt !== undefined);
  const day = new Date(updated.doneAt);
  assert.deepEqual([day.getFullYear(), day.getMonth(), day.getDate(), day.getHours()], [2026, 9, 1, 12]);
  assert.equal(updated.events.length, done.events.length);
  assert.deepEqual((await store.read()).directions[0], updated);
});

test('setDoneDate rejects a direction that is not done and a bad day', async t => {
  const store = await tempStore(t);
  const created = await store.createDirection({ title: 'Фильтры' });
  await assert.rejects(store.setDoneDate(created.id, '2026-10-01'), (e: unknown) => e instanceof ValidationError && e.message === 'Направление не в статусе «Готово»: Фильтры');
  await store.setStatus(created.id, 'done');
  for (const bad of ['2026-13-01', '1.10.2026']) {
    await assert.rejects(store.setDoneDate(created.id, bad), (e: unknown) => e instanceof ValidationError && e.message === `Дата должна быть в формате YYYY-MM-DD: ${bad}`);
  }
  await assert.rejects(store.setDoneDate('nope', '2026-10-01'), NotFoundError);
});

test('leaving waiting clears waitingFor', async t => {
  const store = await tempStore(t);
  const created = await store.createDirection({ title: 'Д', status: 'waiting', waitingFor: 'бэк' });
  const updated = await store.setStatus(created.id, 'testing');
  assert.equal(updated.waitingFor, undefined);
  assert.equal(updated.events[0].text, 'Статус: Тестирование');
  assert.equal('waitingFor' in (await store.read()).directions[0], false);
});

test('setStatus places the direction at the given index or at the end of the column', async t => {
  const store = await tempStore(t);
  const a = await store.createDirection({ title: 'A', status: 'testing' });
  const b = await store.createDirection({ title: 'B', status: 'testing' });
  const c = await store.createDirection({ title: 'C' });
  const d = await store.createDirection({ title: 'D' });
  await store.setStatus(c.id, 'testing');
  await store.setStatus(d.id, 'testing', { index: 0 });
  const state = await store.read();
  const column = state.directions.filter(x => x.status === 'testing').sort((x, y) => x.order - y.order);
  assert.deepEqual(column.map(x => x.id), [d.id, a.id, b.id, c.id]);
  assert.deepEqual(column.map(x => x.title), ['D', 'A', 'B', 'C']);
  assert.deepEqual(column.map(x => x.order), [0, 1, 2, 3]);
  assert.equal(state.directions.filter(x => x.status === 'in_progress').length, 0);
});

test('setStatus on a missing direction throws NotFoundError', async t => {
  const store = await tempStore(t);
  await assert.rejects(store.setStatus('nope', 'done'), NotFoundError);
});

test('patchDirection sets and clears waitingFor', async t => {
  const store = await tempStore(t);
  const created = await store.createDirection({ title: 'Д', status: 'waiting' });
  const set = await store.patchDirection(created.id, { waitingFor: 'Олег' });
  assert.equal(set.waitingFor, 'Олег');
  const cleared = await store.patchDirection(created.id, { waitingFor: null });
  assert.equal(cleared.waitingFor, undefined);
  assert.equal('waitingFor' in (await store.read()).directions[0], false);
});

test('addEvent appends a note and rejects empty text', async t => {
  const store = await tempStore(t);
  const created = await store.createDirection({ title: 'Д' });
  const event = await store.addEvent(created.id, 'Созвонились с Олегом', 'manual');
  assert.equal(event.kind, 'note');
  assert.equal(event.source, 'manual');
  assert.equal(event.text, 'Созвонились с Олегом');
  assert.ok(event.id);
  assert.ok(!Number.isNaN(Date.parse(event.at)));
  const stored = (await store.read()).directions[0];
  assert.deepEqual(stored.events, [event]);
  await assert.rejects(store.addEvent(created.id, '   ', 'manual'), ValidationError);
  await assert.rejects(store.addEvent('nope', 'x', 'claude'), NotFoundError);
});

test('addTicket normalizes "app-7301" and ignores duplicates', async t => {
  const store = await tempStore(t);
  const created = await store.createDirection({ title: 'Д' });
  const ticket = await store.addTicket(created.id, 'app-7301');
  assert.deepEqual(ticket, { key: 'APP-7301', platform: 'App', url: 'https://jira.example.com/browse/APP-7301' });
  const duplicate = await store.addTicket(created.id, ' APP-7301 ');
  assert.deepEqual(duplicate, ticket);
  assert.equal((await store.read()).directions[0].tickets.length, 1);
  await assert.rejects(store.addTicket(created.id, 'oops'), ValidationError);
});

test('removeTicket removes by normalized key', async t => {
  const store = await tempStore(t);
  const created = await store.createDirection({ title: 'Д', ticketKeys: ['APP-1', 'WEB-2'] });
  await store.removeTicket(created.id, 'app-1');
  assert.deepEqual((await store.read()).directions[0].tickets.map(x => x.key), ['WEB-2']);
});

test('removing a missing ticket or link keeps updatedAt', async t => {
  const store = await tempStore(t);
  const created = await store.createDirection({ title: 'Д', ticketKeys: ['APP-1'] });
  await store.addLink(created.id, { url: 'https://figma.com/f' });
  const before = (await store.read()).directions[0];
  await store.removeTicket(created.id, 'APP-2');
  await store.removeLink(created.id, 'https://figma.com/nope');
  assert.deepEqual((await store.read()).directions[0], before);
});

test('addLink defaults title to url and detects kind; removeLink removes by url', async t => {
  const store = await tempStore(t);
  const created = await store.createDirection({ title: 'Д' });
  const mr = await store.addLink(created.id, { url: 'https://git.example.com/x/-/merge_requests/7' });
  assert.deepEqual(mr, { title: 'https://git.example.com/x/-/merge_requests/7', url: 'https://git.example.com/x/-/merge_requests/7', kind: 'mr' });
  const figma = await store.addLink(created.id, { url: 'https://figma.com/f', title: 'Макет', kind: 'other' });
  assert.deepEqual(figma, { title: 'Макет', url: 'https://figma.com/f', kind: 'other' });
  await store.removeLink(created.id, mr.url);
  assert.deepEqual((await store.read()).directions[0].links, [figma]);
  await assert.rejects(store.addLink(created.id, { url: ' ' }), ValidationError);
});

test('addLink adds https:// to a bare host and returns an existing link for the same url', async t => {
  const store = await tempStore(t);
  const created = await store.createDirection({ title: 'Д' });
  const link = await store.addLink(created.id, { url: 'figma.com/f', title: 'Макет' });
  assert.deepEqual(link, { title: 'Макет', url: 'https://figma.com/f', kind: 'figma' });
  const again = await store.addLink(created.id, { url: 'https://figma.com/f', title: 'Другое' });
  assert.deepEqual(again, link);
  assert.deepEqual((await store.read()).directions[0].links, [link]);
});

test('addTodo puts new todo first', async t => {
  const store = await tempStore(t);
  const first = await store.addTodo({ text: 'Первое' });
  const second = await store.addTodo({ text: 'Второе', requestedBy: 'Олег', due: '2026-11-06' });
  assert.equal(second.requestedBy, 'Олег');
  assert.equal(second.due, '2026-11-06');
  assert.equal(second.done, false);
  assert.deepEqual((await store.read()).todos.map(x => x.id), [second.id, first.id]);
});

test('addTodo validates direction and due', async t => {
  const store = await tempStore(t);
  const created = await store.createDirection({ title: 'Д' });
  const linked = await store.addTodo({ text: 'Дело', directionId: created.id });
  assert.equal(linked.directionId, created.id);
  await assert.rejects(store.addTodo({ text: 'X', directionId: 'nope' }), NotFoundError);
  await assert.rejects(store.addTodo({ text: 'X', due: '06.11.2026' }), ValidationError);
  await assert.rejects(store.addTodo({ text: 'X', due: '2026-13-45' }), ValidationError);
  await assert.rejects(store.addTodo({ text: ' ' }), ValidationError);
  assert.equal((await store.read()).todos.length, 1);
});

test('updateTodo patches fields and null removes them', async t => {
  const store = await tempStore(t);
  const created = await store.createDirection({ title: 'Д' });
  const todo = await store.addTodo({ text: 'Дело', directionId: created.id, requestedBy: 'Олег', due: '2026-11-06' });
  const patched = await store.updateTodo(todo.id, { text: 'Дело 2', directionId: null, requestedBy: null, due: '2026-11-07' });
  assert.equal(patched.text, 'Дело 2');
  assert.equal(patched.due, '2026-11-07');
  assert.equal('directionId' in patched, false);
  assert.equal('requestedBy' in patched, false);
  const cleared = await store.updateTodo(todo.id, { due: null });
  assert.equal('due' in cleared, false);
  assert.deepEqual((await store.read()).todos[0], cleared);
  await assert.rejects(store.updateTodo(todo.id, { directionId: 'nope' }), NotFoundError);
  await assert.rejects(store.updateTodo(todo.id, { due: 'завтра' }), ValidationError);
  await assert.rejects(store.updateTodo('nope', { text: 'x' }), NotFoundError);
});

test('setTodoDone adds todo-done event "Завести задачу бэку (от Олега)" and undo removes it', async t => {
  const store = await tempStore(t);
  const created = await store.createDirection({ title: 'Д' });
  const todo = await store.addTodo({ text: 'Завести задачу бэку', directionId: created.id, requestedBy: 'Олега' });

  const done = await store.setTodoDone(todo.id, true);
  assert.equal(done.done, true);
  assert.ok(done.doneAt && !Number.isNaN(Date.parse(done.doneAt)));
  let events = (await store.read()).directions[0].events;
  assert.equal(events.length, 1);
  assert.equal(events[0].text, 'Завести задачу бэку (от Олега)');
  assert.equal(events[0].kind, 'todo-done');
  assert.equal(events[0].source, 'system');
  assert.equal(events[0].todoId, todo.id);

  const [first] = events;
  await store.setTodoDone(todo.id, true);
  assert.deepEqual((await store.read()).directions[0].events, [first]);

  const undone = await store.setTodoDone(todo.id, false);
  assert.equal(undone.done, false);
  assert.equal('doneAt' in undone, false);
  events = (await store.read()).directions[0].events;
  assert.deepEqual(events, []);
});

test('setTodoDone without requestedBy or direction writes plain text or no event', async t => {
  const store = await tempStore(t);
  const created = await store.createDirection({ title: 'Д' });
  const linked = await store.addTodo({ text: 'Поправить', directionId: created.id });
  const loose = await store.addTodo({ text: 'Без направления' });
  await store.setTodoDone(linked.id, true);
  await store.setTodoDone(loose.id, true);
  const state = await store.read();
  assert.deepEqual(state.directions[0].events.map(e => e.text), ['Поправить']);
  assert.equal(state.todos.every(x => x.done), true);
});

async function doneTodoIn(store: Store, title: string): Promise<{ directionId: string; todoId: string }> {
  const direction = await store.createDirection({ title });
  const todo = await store.addTodo({ text: 'Дело', directionId: direction.id });
  await store.addEvent(direction.id, 'Раньше', 'manual');
  await store.setTodoDone(todo.id, true);
  await store.addEvent(direction.id, 'Позже', 'manual');
  return { directionId: direction.id, todoId: todo.id };
}

test('updateTodo of a done todo rewrites its event text in place', async t => {
  const store = await tempStore(t);
  const { todoId } = await doneTodoIn(store, 'Д');
  const [, before] = (await store.read()).directions[0].events;
  await store.updateTodo(todoId, { text: 'Дело 2', requestedBy: 'Олега' });
  const events = (await store.read()).directions[0].events;
  assert.deepEqual(events.map(e => e.text), ['Раньше', 'Дело 2 (от Олега)', 'Позже']);
  assert.deepEqual(events[1], { ...before, text: 'Дело 2 (от Олега)' });
  await store.updateTodo(todoId, { requestedBy: null });
  assert.equal((await store.read()).directions[0].events[1].text, 'Дело 2');
});

test('updateTodo moves the todo-done event to the new direction by time, null removes it', async t => {
  const store = await tempStore(t);
  const from = await doneTodoIn(store, 'Откуда');
  const to = await store.createDirection({ title: 'Куда' });
  const original = (await store.read()).directions.find(d => d.id === from.directionId)?.events[1];
  assert.ok(original);
  await new Promise(resolve => setTimeout(resolve, 5));
  await store.addEvent(to.id, 'Новое', 'manual');
  await store.updateTodo(from.todoId, { directionId: to.id });
  let state = await store.read();
  assert.deepEqual(state.directions.find(d => d.id === from.directionId)?.events.map(e => e.text), ['Раньше', 'Позже']);
  const moved = state.directions.find(d => d.id === to.id)?.events ?? [];
  assert.deepEqual(moved.map(e => e.text), ['Дело', 'Новое']);
  assert.deepEqual(moved[0], original);

  await store.updateTodo(from.todoId, { directionId: null });
  state = await store.read();
  assert.equal(state.directions.some(d => d.events.some(e => e.kind === 'todo-done')), false);
});

test('deleteTodo keeps an already written todo-done event', async t => {
  const store = await tempStore(t);
  const { todoId } = await doneTodoIn(store, 'Д');
  await store.deleteTodo(todoId);
  const events = (await store.read()).directions[0].events;
  assert.deepEqual(events.map(e => [e.kind, e.todoId]), [
    ['note', undefined],
    ['todo-done', todoId],
    ['note', undefined],
  ]);
});

test('moveTodo reorders and clamps the index; deleteTodo removes', async t => {
  const store = await tempStore(t);
  const a = await store.addTodo({ text: 'A' });
  const b = await store.addTodo({ text: 'B' });
  const c = await store.addTodo({ text: 'C' });
  assert.deepEqual((await store.read()).todos.map(x => x.text), ['C', 'B', 'A']);
  await store.moveTodo(a.id, 0);
  assert.deepEqual((await store.read()).todos.map(x => x.text), ['A', 'C', 'B']);
  await store.moveTodo(a.id, 99);
  assert.deepEqual((await store.read()).todos.map(x => x.text), ['C', 'B', 'A']);
  await store.deleteTodo(b.id);
  assert.deepEqual((await store.read()).todos.map(x => x.id), [c.id, a.id]);
  await assert.rejects(store.moveTodo('nope', 0), NotFoundError);
  await assert.rejects(store.deleteTodo('nope'), NotFoundError);
});

test('deleteDirection unlinks its todos', async t => {
  const store = await tempStore(t);
  const keep = await store.createDirection({ title: 'Остаётся' });
  const gone = await store.createDirection({ title: 'Удаляется' });
  const linkedGone = await store.addTodo({ text: 'Дело 1', directionId: gone.id });
  const linkedKeep = await store.addTodo({ text: 'Дело 2', directionId: keep.id });
  await store.deleteDirection(gone.id);
  const state = await store.read();
  assert.deepEqual(state.directions.map(d => d.id), [keep.id]);
  const todoGone = state.todos.find(x => x.id === linkedGone.id);
  assert.ok(todoGone);
  assert.equal('directionId' in todoGone, false);
  assert.equal(state.todos.find(x => x.id === linkedKeep.id)?.directionId, keep.id);
  await assert.rejects(store.deleteDirection('nope'), NotFoundError);
});

test('addQuickLink creates the group by title and appends to an existing one', async t => {
  const store = await tempStore(t);
  const group = await store.addQuickLink('Стенды', { title: 'dev', url: 'https://dev.shop.example.com' });
  assert.equal(group.title, 'Стенды');
  assert.deepEqual(group.links, [{ title: 'dev', url: 'https://dev.shop.example.com' }]);
  const same = await store.addQuickLink('Стенды', { title: 'prod', url: 'https://shop.example.com' });
  assert.equal(same.id, group.id);
  assert.equal(same.links.length, 2);
  const state = await store.read();
  assert.equal(state.linkGroups.length, 1);
  assert.deepEqual(state.linkGroups[0], same);
});

test('addQuickLink adds https:// and skips a url already in the group', async t => {
  const store = await tempStore(t);
  const group = await store.addQuickLink('Стенды', { title: 'dev', url: 'dev.shop.example.com' });
  assert.deepEqual(group.links, [{ title: 'dev', url: 'https://dev.shop.example.com' }]);
  const same = await store.addQuickLink('Стенды', { title: 'дев', url: 'https://dev.shop.example.com' });
  assert.deepEqual(same, group);
  const other = await store.addQuickLink('Другие', { title: 'dev', url: 'https://dev.shop.example.com' });
  assert.equal(other.links.length, 1);
  assert.equal((await store.read()).linkGroups.length, 2);
});

test('removeQuickLink removes the link and keeps an emptied group', async t => {
  const store = await tempStore(t);
  const group = await store.addQuickLink('Стенды', { title: 'dev', url: 'https://dev.shop.example.com' });
  await store.addQuickLink('Стенды', { title: 'prod', url: 'https://shop.example.com' });
  await store.removeQuickLink(group.id, 'https://dev.shop.example.com');
  assert.deepEqual((await store.read()).linkGroups[0].links.map(l => l.title), ['prod']);
  await store.removeQuickLink(group.id, 'https://shop.example.com');
  assert.deepEqual((await store.read()).linkGroups, [{ ...group, links: [] }]);
  await assert.rejects(store.removeQuickLink('nope', 'x'), NotFoundError);
});

test('removeQuickLinkGroup deletes the group with its links', async t => {
  const store = await tempStore(t);
  const keep = await store.addQuickLink('Jira', { title: 'Борда', url: 'https://jr.test' });
  const gone = await store.addQuickLink('Стенды', { title: 'dev', url: 'https://dev.shop.example.com' });
  await store.removeQuickLinkGroup(gone.id);
  assert.deepEqual((await store.read()).linkGroups, [keep]);
  await assert.rejects(store.removeQuickLinkGroup('nope'), NotFoundError);
});
