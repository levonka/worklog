import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Direction, QuickLinkGroup, Todo } from '../shared/model.ts';
import { EMPTY_STATE, currentPeriodStart } from '../shared/model.ts';
import { DataError } from './fs-utils.ts';
import type { NewDirectionInput } from './store.ts';
import { Store, ValidationError } from './store.ts';
import { TEST_PROFILE } from '../shared/test-profile.ts';

async function tempDataDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function direction(id: string): Direction {
  return {
    id,
    title: `Направление ${id}`,
    status: 'waiting',
    waitingFor: 'девопсы',
    tickets: [{ key: 'APP-9355', platform: 'App', url: 'https://jira.example.com/browse/APP-9355' }],
    links: [{ title: 'MR', url: 'https://git.example.com/x/-/merge_requests/1', kind: 'mr' }],
    events: [{ id: 'e1', at: '2026-11-05T10:00:00.000Z', text: 'Начал', source: 'manual', kind: 'note' }],
    order: 0,
    createdAt: '2026-11-05T10:00:00.000Z',
    updatedAt: '2026-11-05T10:00:00.000Z',
  };
}

function todo(id: string): Todo {
  return { id, text: `Дело ${id}`, done: false, createdAt: '2026-11-05T10:00:00.000Z' };
}

function linkGroup(id: string): QuickLinkGroup {
  return { id, title: 'Стенды', links: [{ title: 'dev', url: 'https://dev.shop.example.com' }] };
}

test('read on missing data dir returns EMPTY_STATE', async t => {
  const dataDir = path.join(await tempDataDir(t), 'data');
  assert.deepEqual(await new Store(dataDir, { profile: TEST_PROFILE }).read(), EMPTY_STATE);
});

test('mutate persists direction, todos and link groups', async t => {
  const dataDir = await tempDataDir(t);
  const result = await new Store(dataDir, { profile: TEST_PROFILE }).mutate(s => {
    s.directions.push(direction('d1'));
    s.todos.push(todo('t1'), todo('t2'));
    s.linkGroups.push(linkGroup('g1'));
    return 'done';
  });

  assert.equal(result, 'done');
  assert.deepEqual(await new Store(dataDir, { profile: TEST_PROFILE }).read(), {
    directions: [direction('d1')],
    todos: [todo('t1'), todo('t2')],
    repeats: [],
    linkGroups: [linkGroup('g1')],
    dailies: [],
    draft: null,
    notes: [],
    runs: [],
  });
  const text = await readFile(path.join(dataDir, 'directions', 'd1.json'), 'utf8');
  assert.equal(text, `${JSON.stringify(direction('d1'), null, 2)}\n`);
});

test('concurrent mutations from two Store instances both persist', async t => {
  const dataDir = await tempDataDir(t);
  const stores = [new Store(dataDir, { profile: TEST_PROFILE }), new Store(dataDir, { profile: TEST_PROFILE })];
  const ids = Array.from({ length: 20 }, (_, i) => `t${i}`);

  await Promise.all(ids.map((id, i) => stores[i % 2].mutate(s => void s.todos.push(todo(id)))));

  const { todos } = await new Store(dataDir, { profile: TEST_PROFILE }).read();
  assert.equal(todos.length, 20);
  assert.deepEqual(new Set(todos.map(item => item.id)), new Set(ids));
});

test('corrupt direction file raises error naming the file and is not overwritten', async t => {
  const dataDir = await tempDataDir(t);
  const file = path.join(dataDir, 'directions', 'x.json');
  await mkdir(path.dirname(file));
  await writeFile(file, '{');
  const store = new Store(dataDir, { profile: TEST_PROFILE });
  const corrupt = { message: /^Повреждён файл данных: .*directions\/x\.json$/ };

  await assert.rejects(store.read(), corrupt);
  await assert.rejects(
    store.mutate(s => void s.directions.push(direction('d1'))),
    corrupt,
  );

  assert.equal(await readFile(file, 'utf8'), '{');
  await assert.rejects(access(path.join(dataDir, 'directions', 'd1.json')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(dataDir, '.lock')), { code: 'ENOENT' });
});

test('deleting a direction removes its file', async t => {
  const dataDir = await tempDataDir(t);
  const store = new Store(dataDir, { profile: TEST_PROFILE });
  await store.mutate(s => void s.directions.push(direction('d1'), direction('d2')));

  await store.mutate(s => {
    s.directions = s.directions.filter(d => d.id !== 'd1');
  });

  await assert.rejects(access(path.join(dataDir, 'directions', 'd1.json')), { code: 'ENOENT' });
  assert.deepEqual((await store.read()).directions.map(d => d.id), ['d2']);
});

test('mutate rewrites only changed files', async t => {
  const dataDir = await tempDataDir(t);
  const store = new Store(dataDir, { profile: TEST_PROFILE });
  const directionFile = path.join(dataDir, 'directions', 'd1.json');
  await store.mutate(s => void s.directions.push(direction('d1')));
  await assert.rejects(access(path.join(dataDir, 'todos.json')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(dataDir, 'links.json')), { code: 'ENOENT' });

  const past = new Date('2020-01-01T00:00:00Z');
  await utimes(directionFile, past, past);
  await store.mutate(s => void s.todos.push(todo('t1')));

  assert.equal((await stat(directionFile)).mtimeMs, past.getTime());
  assert.deepEqual((await store.read()).todos, [todo('t1')]);
});

test('mutate waits while another process holds the lock', async t => {
  const dataDir = await tempDataDir(t);
  const lockDir = path.join(dataDir, '.lock');
  await mkdir(lockDir);
  let settled = false;
  const pending = new Store(dataDir, { profile: TEST_PROFILE }).mutate(s => void s.todos.push(todo('t1'))).finally(() => {
    settled = true;
  });

  await sleep(150);
  assert.equal(settled, false);
  await rm(lockDir, { recursive: true });
  await pending;

  assert.deepEqual((await new Store(dataDir, { profile: TEST_PROFILE }).read()).todos, [todo('t1')]);
});

test('lock older than 10 s is treated as abandoned', async t => {
  const dataDir = await tempDataDir(t);
  const lockDir = path.join(dataDir, '.lock');
  await mkdir(lockDir);
  const past = new Date(Date.now() - 11_000);
  await utimes(lockDir, past, past);

  await new Store(dataDir, { profile: TEST_PROFILE }).mutate(s => void s.todos.push(todo('t1')));

  assert.deepEqual((await new Store(dataDir, { profile: TEST_PROFILE }).read()).todos, [todo('t1')]);
  await assert.rejects(access(lockDir), { code: 'ENOENT' });
});

test('mutate refuses two directions with one id and writes nothing', async t => {
  const dataDir = await tempDataDir(t);
  const store = new Store(dataDir, { profile: TEST_PROFILE });
  await store.mutate(s => void s.directions.push(direction('d1')));
  const file = path.join(dataDir, 'directions', 'd1.json');
  const before = await readFile(file, 'utf8');

  await assert.rejects(
    store.mutate(s => {
      s.directions.push({ ...direction('d1'), title: 'Дубль' });
      s.todos.push(todo('t1'));
    }),
    { message: /d1/ },
  );

  assert.equal(await readFile(file, 'utf8'), before);
  await assert.rejects(access(path.join(dataDir, 'todos.json')), { code: 'ENOENT' });
});

test('mutate rejects an async fn before writing', async t => {
  const dataDir = await tempDataDir(t);
  const store = new Store(dataDir, { profile: TEST_PROFILE });
  await store.mutate(s => void s.todos.push(todo('t1')));
  const file = path.join(dataDir, 'todos.json');
  const before = await readFile(file, 'utf8');

  await assert.rejects(
    // @ts-expect-error mutate takes only a synchronous fn
    store.mutate(async s => {
      s.todos.push(todo('t2'));
      await sleep(1);
      s.todos.push(todo('t3'));
    }),
    { message: /синхронной/ },
  );

  assert.equal(await readFile(file, 'utf8'), before);
  await assert.rejects(access(path.join(dataDir, '.lock')), { code: 'ENOENT' });
});

test('read rejects a direction file of the wrong shape', async t => {
  const dataDir = await tempDataDir(t);
  await mkdir(path.join(dataDir, 'directions'));
  await writeFile(path.join(dataDir, 'directions', 'x.json'), JSON.stringify({ id: 'x', title: 'Без полей' }));

  await assert.rejects(new Store(dataDir, { profile: TEST_PROFILE }).read(), DataError);
});

test('read accepts a direction with doneAt and rejects a non-string doneAt', async t => {
  const dataDir = await tempDataDir(t);
  await mkdir(path.join(dataDir, 'directions'));
  const file = path.join(dataDir, 'directions', 'd1.json');
  await writeFile(file, JSON.stringify({ ...direction('d1'), status: 'done', doneAt: '2026-10-30T09:00:00.000Z' }));
  assert.equal((await new Store(dataDir, { profile: TEST_PROFILE }).read()).directions[0].doneAt, '2026-10-30T09:00:00.000Z');

  await writeFile(file, JSON.stringify({ ...direction('d1'), status: 'done', doneAt: 5 }));
  await assert.rejects(new Store(dataDir, { profile: TEST_PROFILE }).read(), DataError);
});

test('read accepts a ticket with jira and rejects a malformed one', async t => {
  const dataDir = await tempDataDir(t);
  await mkdir(path.join(dataDir, 'directions'));
  const file = path.join(dataDir, 'directions', 'd1.json');
  const at = '2026-11-06T09:00:00.000Z';
  const ticket = { key: 'APP-1', platform: 'App', url: 'https://jira.example.com/browse/APP-1' };
  const event = { id: 'e1', at, text: 'APP-1: Open → In QA', source: 'jira', kind: 'jira-status' };
  await writeFile(file, JSON.stringify({ ...direction('d1'), tickets: [{ ...ticket, jira: { status: 'In QA', segments: ['EU'], at } }], events: [event] }));
  const read = (await new Store(dataDir, { profile: TEST_PROFILE }).read()).directions[0];
  assert.deepEqual(read.tickets[0].jira, { status: 'In QA', segments: ['EU'], at });
  assert.equal(read.events[0].source, 'jira');

  await writeFile(file, JSON.stringify({ ...direction('d1'), tickets: [{ ...ticket, jira: { status: 'In QA', segments: 'EU', at } }] }));
  await assert.rejects(new Store(dataDir, { profile: TEST_PROFILE }).read(), DataError);
});

test('read rejects a direction whose id differs from its file name', async t => {
  const dataDir = await tempDataDir(t);
  await mkdir(path.join(dataDir, 'directions'));
  await writeFile(path.join(dataDir, 'directions', 'x.json'), JSON.stringify(direction('d1')));

  await assert.rejects(new Store(dataDir, { profile: TEST_PROFILE }).read(), { message: /directions\/x\.json$/ });
});

test('a ticket with a platform the profile does not know still reads', async t => {
  const dataDir = await tempDataDir(t);
  await mkdir(path.join(dataDir, 'directions'));
  const old = { ...direction('d1'), tickets: [{ key: 'OLD-1', platform: 'Legacy', url: 'https://old.example.com/browse/OLD-1' }] };
  await writeFile(path.join(dataDir, 'directions', 'd1.json'), JSON.stringify(old));

  const state = await new Store(dataDir, { profile: TEST_PROFILE }).read();
  assert.deepEqual(state.directions[0].tickets, old.tickets);
});

test('addTicket uses the store profile', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  const { id } = await store.createDirection({ title: 'Поиск' });
  assert.deepEqual(await store.addTicket(id, 'app-7'), { key: 'APP-7', platform: 'App', url: 'https://jira.example.com/browse/APP-7' });
});

for (const name of ['todos.json', 'links.json']) {
  test(`read rejects a corrupt ${name}`, async t => {
    const dataDir = await tempDataDir(t);
    const file = path.join(dataDir, name);

    await writeFile(file, '[');
    await assert.rejects(new Store(dataDir, { profile: TEST_PROFILE }).read(), DataError);
    await writeFile(file, JSON.stringify([{ id: 'x' }]));
    await assert.rejects(new Store(dataDir, { profile: TEST_PROFILE }).read(), { message: new RegExp(`${name.replace('.', '\\.')}$`) });
  });
}

test('notes are Markdown files: create, update, delete, read back', async t => {
  const dataDir = await tempDataDir(t);
  const store = new Store(dataDir, { profile: TEST_PROFILE });
  const dir = await store.createDirection({ title: 'US пуши' });
  const note = await store.createNote({
    title: '  Общий origin ',
    body: ' Ключи `app.*` \n',
    directionIds: [dir.id, dir.id],
    files: [{ path: ' libs/x/README.md' }, { path: 'libs/x/README.md' }, { path: 'a.ts', line: 4 }],
    urls: [{ url: 'wiki.test/p', title: ' ' }],
  });
  assert.deepEqual(
    { title: note.title, body: note.body, directionIds: note.directionIds, files: note.files, urls: note.urls },
    { title: 'Общий origin', body: 'Ключи `app.*`', directionIds: [dir.id], files: [{ path: 'libs/x/README.md' }, { path: 'a.ts', line: 4 }], urls: [{ url: 'https://wiki.test/p' }] },
  );
  const file = path.join(dataDir, 'notes', `${note.id}.md`);
  assert.match(await readFile(file, 'utf8'), /^---\ntitle: "Общий origin"\n[\s\S]*\n---\n\nКлючи `app\.\*`\n$/);
  assert.deepEqual((await store.read()).notes, [note]);

  const same = await store.updateNote(note.id, { title: 'Общий origin' });
  assert.equal(same.updatedAt, note.updatedAt);
  await sleep(5);
  const updated = await store.updateNote(note.id, { body: 'Новое', urls: [] });
  assert.equal(updated.body, 'Новое');
  assert.deepEqual(updated.urls, []);
  assert.notEqual(updated.updatedAt, note.updatedAt);

  await store.deleteNote(note.id);
  assert.deepEqual((await store.read()).notes, []);
  await assert.rejects(access(file));
});

test('notes refuse unknown directions, unsafe paths and bad lines', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  await assert.rejects(store.createNote({ title: ' ' }), /Заголовок/);
  await assert.rejects(store.createNote({ title: 'x', directionIds: ['nope'] }), /не найдено/i);
  await assert.rejects(store.createNote({ title: 'x', files: [{ path: '../x' }] }), /относительным/);
  await assert.rejects(store.createNote({ title: 'x', files: [{ path: 'a.ts', line: 0 }] }), /строки/);
  await assert.rejects(store.updateNote('nope', { title: 'x' }), /Заметка не найдена/);
  assert.deepEqual((await store.read()).notes, []);
});

test('deleting a direction takes it off its notes; a broken note file is a data error', async t => {
  const dataDir = await tempDataDir(t);
  const store = new Store(dataDir, { profile: TEST_PROFILE });
  const a = await store.createDirection({ title: 'A' });
  const b = await store.createDirection({ title: 'B' });
  const note = await store.createNote({ title: 'x', directionIds: [a.id, b.id] });
  await store.deleteDirection(a.id);
  assert.deepEqual((await store.read()).notes[0].directionIds, [b.id]);

  await writeFile(path.join(dataDir, 'notes', `${note.id}.md`), 'не заметка');
  await assert.rejects(store.read(), DataError);
});

test('link descriptions on directions and quick links: add, change, clear', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  const dir = await store.createDirection({ title: 'КЭДО' });
  const link = await store.addLink(dir.id, { url: 'https://docs.example.com/', title: 'КЭДО', description: ' Кадровый документооборот \n' });
  assert.equal(link.description, 'Кадровый документооборот');
  assert.equal((await store.setLinkDescription(dir.id, link.url, 'Отпуска\nи справки')).description, 'Отпуска\nи справки');
  assert.equal('description' in (await store.setLinkDescription(dir.id, link.url, '  ')), false);
  await assert.rejects(store.setLinkDescription(dir.id, 'https://nope.test/', 'x'), /Ссылка не найдена/);

  const group = await store.addQuickLink('Корпоративное', { title: 'КЭДО', url: 'https://docs.example.com/', description: 'Подписать документы' });
  assert.equal(group.links[0].description, 'Подписать документы');
  assert.equal('description' in (await store.setQuickLinkDescription(group.id, group.links[0].url, null)), false);
  assert.equal((await store.setQuickLinkDescription(group.id, group.links[0].url, 'Логин — корпоративный')).description, 'Логин — корпоративный');
});

test('repeat rules make one todo a day on their days and move an open one forward', async t => {
  const dataDir = await tempDataDir(t);
  const store = new Store(dataDir, { profile: TEST_PROFILE });
  const dir = await store.createDirection({ title: 'Почта' });
  const daily = await store.addRepeat({ text: ' Проверить почту ', days: ['sun', 'mon'], directionId: dir.id });
  const monday = await store.addRepeat({ text: 'Встреча', days: ['mon'] });
  assert.equal(daily.text, 'Проверить почту');
  assert.deepEqual(daily.days, ['mon', 'sun']);

  assert.equal(await store.applyRepeats(new Date(2026, 10, 9, 9)), 2);
  assert.equal(await store.applyRepeats(new Date(2026, 10, 9, 18)), 0);
  let todos = (await store.read()).todos;
  assert.deepEqual(todos.map(t => [t.text, t.due, t.repeatId, t.directionId]).sort(), [
    ['Встреча', '2026-11-09', monday.id, undefined],
    ['Проверить почту', '2026-11-09', daily.id, dir.id],
  ]);

  // deleted today: not made again the same day
  await store.deleteTodo(todos.find(t => t.repeatId === monday.id)?.id ?? '');
  assert.equal(await store.applyRepeats(new Date(2026, 10, 9, 20)), 0);

  // Tuesday is no day of either; Sunday moves the open mail todo instead of adding a second one
  assert.equal(await store.applyRepeats(new Date(2026, 10, 10, 9)), 0);
  assert.equal(await store.applyRepeats(new Date(2026, 10, 15, 9)), 1);
  todos = (await store.read()).todos;
  assert.deepEqual(todos.map(t => [t.text, t.due]), [['Проверить почту', '2026-11-15']]);

  // done today, made anew next time
  await store.setTodoDone(todos[0].id, true);
  assert.equal(await store.applyRepeats(new Date(2026, 10, 16, 9)), 2);
  assert.equal((await store.read()).todos.filter(t => !t.done).length, 2);
});

test('todos carry a link and a time, which can be changed and removed', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  const todo = await store.addTodo({ text: 'Звонок', url: ' meet.example.com/f416 ', time: '9.05' });
  assert.equal(todo.url, 'https://meet.example.com/f416');
  assert.equal(todo.time, '09:05');
  assert.equal((await store.updateTodo(todo.id, { time: '12:00' })).time, '12:00');
  const cleared = await store.updateTodo(todo.id, { url: null, time: null });
  assert.equal('url' in cleared || 'time' in cleared, false);
  await assert.rejects(store.addTodo({ text: 'x', time: '25:00' }), /Время/);
  await assert.rejects(store.updateTodo(todo.id, { url: '  ' }), /Ссылка/);
});

test('a repeat rule gives its link and time to the todos it makes; editing it updates its open todo', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  const rule = await store.addRepeat({ text: 'Платформенный звонок', days: ['mon'], url: 'meet.example.com/f416', time: '12.00' });
  assert.equal(rule.url, 'https://meet.example.com/f416');
  assert.equal(rule.time, '12:00');
  await store.applyRepeats(new Date(2026, 10, 9, 9));
  const [made] = (await store.read()).todos;
  assert.deepEqual([made.url, made.time], ['https://meet.example.com/f416', '12:00']);

  await store.setTodoDone(made.id, true);
  await store.applyRepeats(new Date(2026, 10, 16, 9));
  const edited = await store.updateRepeat(rule.id, { url: 'mail.example.com', time: null });
  assert.equal(edited.url, 'https://mail.example.com');
  assert.equal('time' in edited, false);
  const todos = (await store.read()).todos;
  const open = todos.find(t => !t.done);
  const done = todos.find(t => t.done);
  assert.deepEqual([open?.url, open?.time], ['https://mail.example.com', undefined]);
  assert.deepEqual([done?.url, done?.time], ['https://meet.example.com/f416', '12:00']);
  await assert.rejects(store.updateRepeat('nope', { time: null }), /Повтор не найден/);
  await assert.rejects(store.updateRepeat(rule.id, { time: '7' }), /Время/);
});

test('removing a repeat rule keeps its todos as ordinary ones; deleting a direction unbinds its rules', async t => {
  const dataDir = await tempDataDir(t);
  const store = new Store(dataDir, { profile: TEST_PROFILE });
  const dir = await store.createDirection({ title: 'Почта' });
  const rule = await store.addRepeat({ text: 'Проверить почту', days: ['mon'], directionId: dir.id, requestedBy: 'Олега' });
  await store.applyRepeats(new Date(2026, 10, 9, 9));
  await store.deleteDirection(dir.id);
  assert.equal('directionId' in (await store.read()).repeats[0], false);

  await store.removeRepeat(rule.id);
  const state = await store.read();
  assert.deepEqual(state.repeats, []);
  assert.equal('repeatId' in state.todos[0], false);
  await assert.rejects(access(path.join(dataDir, 'repeats.json')));
  await assert.rejects(store.removeRepeat(rule.id), /Повтор не найден/);
  await assert.rejects(store.addRepeat({ text: 'x', days: [] }), /дни/);
  await assert.rejects(store.addRepeat({ text: 'x', days: ['mon'], directionId: 'nope' }), /Направление не найдено/);
});

// --- Jira ---

const JIRA_AT = '2026-11-06T09:00:00.000Z';
const JIRA_LATER = '2026-11-06T09:05:00.000Z';

test('applyJira stores the first status without an event', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  const dir = await store.createDirection({ title: 'SEO', ticketKeys: ['APP-1'] });

  assert.equal(await store.applyJira([{ key: 'APP-1', status: 'Open', segments: ['EU'] }], JIRA_AT), 1);

  const saved = (await store.read()).directions.find(d => d.id === dir.id);
  assert.deepEqual(saved?.tickets[0].jira, { status: 'Open', segments: ['EU'], at: JIRA_AT });
  assert.deepEqual(saved?.events, []);
});

test('applyJira writes an event when the status changes', async t => {
  const dataDir = await tempDataDir(t);
  const dir = await new Store(dataDir, { profile: TEST_PROFILE }).createDirection({ title: 'SEO', ticketKeys: ['WEB-5586'] });
  await new Store(dataDir, { profile: TEST_PROFILE }).applyJira([{ key: 'WEB-5586', status: 'In Review', segments: ['EU'] }], JIRA_AT);

  // a fresh store, as after a restart: the old status comes from the file
  const store = new Store(dataDir, { profile: TEST_PROFILE });
  await store.applyJira([{ key: 'WEB-5586', status: 'In QA', segments: ['EU'] }], JIRA_LATER);

  const saved = (await store.read()).directions.find(d => d.id === dir.id);
  const last = saved?.events.at(-1);
  assert.equal(last?.text, 'WEB-5586: In Review → In QA');
  assert.equal(last?.source, 'jira');
  assert.equal(last?.kind, 'jira-status');
  assert.equal(last?.at, JIRA_LATER);
  assert.equal(saved?.tickets[0].jira?.at, JIRA_LATER);
});

test('applyJira changes segments without an event', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  const dir = await store.createDirection({ title: 'SEO', ticketKeys: ['APP-1'] });
  await store.applyJira([{ key: 'APP-1', status: 'Open', segments: ['EU'] }], JIRA_AT);

  await store.applyJira([{ key: 'APP-1', status: 'Open', segments: ['EU', 'US'] }], JIRA_LATER);

  const saved = (await store.read()).directions.find(d => d.id === dir.id);
  assert.deepEqual(saved?.tickets[0].jira, { status: 'Open', segments: ['EU', 'US'], at: JIRA_LATER });
  assert.deepEqual(saved?.events, []);
});

test('applyJira leaves files untouched when nothing changed', async t => {
  const dataDir = await tempDataDir(t);
  await new Store(dataDir, { profile: TEST_PROFILE }).createDirection({ title: 'SEO', ticketKeys: ['APP-1'] });
  await new Store(dataDir, { profile: TEST_PROFILE }).applyJira([{ key: 'APP-1', status: 'Open', segments: ['EU'] }], JIRA_AT);
  let commits = 0;
  const store = new Store(dataDir, { onCommit: () => commits++, profile: TEST_PROFILE });

  assert.equal(await store.applyJira([{ key: 'APP-1', status: 'Open', segments: ['EU'] }], JIRA_LATER), 0);

  assert.equal(commits, 0);
  assert.equal((await store.read()).directions[0].tickets[0].jira?.at, JIRA_AT);
});

test('applyJira skips done directions and keys Jira did not return', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  await store.createDirection({ title: 'Готово', status: 'done', ticketKeys: ['APP-1'] });
  await store.createDirection({ title: 'Опечатка', ticketKeys: ['APP-404'] });

  assert.equal(await store.applyJira([{ key: 'APP-1', status: 'Closed', segments: [] }], JIRA_AT), 0);

  for (const dir of (await store.read()).directions) assert.equal(dir.tickets[0].jira, undefined);
});

test('applyJira does not touch updatedAt', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  const dir = await store.createDirection({ title: 'SEO', ticketKeys: ['APP-1'] });
  await store.applyJira([{ key: 'APP-1', status: 'Open', segments: [] }], JIRA_AT);
  await store.applyJira([{ key: 'APP-1', status: 'In QA', segments: [] }], JIRA_LATER);

  assert.equal((await store.read()).directions[0].updatedAt, dir.updatedAt);
});

test('applyJira updates every direction holding the key', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  await store.createDirection({ title: 'Первое', ticketKeys: ['APP-1'] });
  await store.createDirection({ title: 'Второе', ticketKeys: ['APP-1'] });
  await store.applyJira([{ key: 'APP-1', status: 'Open', segments: [] }], JIRA_AT);

  assert.equal(await store.applyJira([{ key: 'APP-1', status: 'In QA', segments: [] }], JIRA_LATER), 2);

  for (const dir of (await store.read()).directions) assert.deepEqual(dir.events.map(e => e.text), ['Статус: Тестирование', 'APP-1: Open → In QA']);
});

// --- merge requests ---

const MR_4022 = 'https://git.example.com/team/app/-/merge_requests/4022';

test('applyMergeRequests adds the MR link of the direction branch once, without an event', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  const dir = await store.createDirection({ title: 'SEO', ticketKeys: ['APP-9355', 'WEB-5586'] });
  const found = new Map([['feature/APP-9355_WEB-5586', 4022]]);

  assert.equal(await store.applyMergeRequests(found), 1);
  assert.equal(await store.applyMergeRequests(found), 0);

  const saved = (await store.read()).directions[0];
  assert.deepEqual(saved.links, [{ title: 'MR !4022', url: MR_4022, kind: 'mr' }]);
  assert.deepEqual(saved.events, []);
  assert.equal(saved.updatedAt, dir.updatedAt);
});

test('applyMergeRequests adds no link without a merge request url', async t => {
  const { gitlab: _gitlab, ...withoutGitlab } = TEST_PROFILE;
  const store = new Store(await tempDataDir(t), { profile: withoutGitlab });
  await store.createDirection({ title: 'SEO', ticketKeys: ['APP-9355'] });

  assert.equal(await store.applyMergeRequests(new Map([['feature/APP-9355', 4022]])), 0);
  assert.deepEqual((await store.read()).directions[0].links, []);
});

test('applyMergeRequests keeps a link to the same MR the user added', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  const dir = await store.createDirection({ title: 'SEO', ticketKeys: ['APP-9355'] });
  await store.addLink(dir.id, { url: `${MR_4022}/diffs`, title: 'мой MR' });

  assert.equal(await store.applyMergeRequests(new Map([['feature/APP-9355', 4022]])), 0);
  assert.equal((await store.read()).directions[0].links.length, 1);
});

test('applyMergeRequests skips done directions and other branches', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  await store.createDirection({ title: 'Готово', status: 'done', ticketKeys: ['APP-1'] });
  await store.createDirection({ title: 'Другое', ticketKeys: ['APP-2'] });

  assert.equal(await store.applyMergeRequests(new Map([['feature/APP-1', 1]])), 0);
  for (const dir of (await store.read()).directions) assert.deepEqual(dir.links, []);
});

// --- the stage from Jira and marks ---

async function savedDirection(store: Store, id: string): Promise<Direction> {
  const found = (await store.read()).directions.find(d => d.id === id);
  assert.ok(found, id);
  return found;
}

/** a direction whose tickets of the profile projects Jira answered once, at JIRA_AT */
async function ledDirection(store: Store, title: string, issues: [string, string][], input: Partial<NewDirectionInput> = {}): Promise<Direction> {
  const created = await store.createDirection({ title, ticketKeys: issues.map(([key]) => key), ...input });
  await store.applyJira(issues.map(([key, status]) => ({ key, status, segments: [] })), JIRA_AT);
  return savedDirection(store, created.id);
}

test('createDirection stores the stage: the status, or В работе under a mark', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  assert.equal((await store.createDirection({ title: 'A', status: 'testing' })).stage, 'testing');
  assert.equal((await store.createDirection({ title: 'B', status: 'waiting', waitingFor: 'девопсы' })).stage, 'in_progress');
});

test('applyJira takes the stage from the profile project tickets without an event the first time', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  const created = await store.createDirection({ title: 'Унификация', status: 'testing', ticketKeys: ['APP-1', 'WEB-2'] });
  await store.applyJira([{ key: 'APP-1', status: 'Open', segments: [] }, { key: 'WEB-2', status: 'Open', segments: [] }], JIRA_AT);

  const saved = await savedDirection(store, created.id);
  assert.equal(saved.status, 'in_progress');
  assert.equal(saved.stage, 'in_progress');
  assert.equal(saved.stageFromJira, true);
  assert.deepEqual(saved.events, []);
});

test('applyJira moves a Jira-led direction back with a stage event before the ticket events', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  await store.createDirection({ title: 'Другое' });
  const led = await ledDirection(store, 'Унификация', [['APP-1', 'In QA']]);
  assert.equal(led.status, 'testing');

  await store.applyJira([{ key: 'APP-1', status: 'Open', segments: [] }], JIRA_LATER);

  const saved = await savedDirection(store, led.id);
  assert.equal(saved.status, 'in_progress');
  assert.deepEqual(
    saved.events.map(e => [e.text, e.source, e.kind, e.at]),
    [
      ['Статус: В работе', 'jira', 'status', JIRA_LATER],
      ['APP-1: In QA → Open', 'jira', 'jira-status', JIRA_LATER],
    ],
  );
  assert.equal(saved.order, 1);
  assert.equal(saved.updatedAt, led.updatedAt);
});

test('applyJira keeps a mark and moves only the stage', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  const led = await ledDirection(store, 'US пуши', [['APP-1', 'Open']], { status: 'waiting', waitingFor: 'девопсы' });

  await store.applyJira([{ key: 'APP-1', status: 'In Review', segments: [] }], JIRA_LATER);

  const saved = await savedDirection(store, led.id);
  assert.equal(saved.status, 'waiting');
  assert.equal(saved.waitingFor, 'девопсы');
  assert.equal(saved.stage, 'in_review');
  assert.equal(saved.events[0].text, 'Статус: В мерж реквесте');
});

test('applyJira sends a direction to done when every profile project ticket is closed', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  const led = await ledDirection(store, 'Тапы', [['APP-1', 'In QA'], ['WEB-2', 'In QA']]);

  await store.applyJira([{ key: 'APP-1', status: 'Closed', segments: [] }, { key: 'WEB-2', status: 'Closed', segments: [] }], JIRA_LATER);

  const saved = await savedDirection(store, led.id);
  assert.equal(saved.status, 'done');
  assert.equal(saved.doneAt, JIRA_LATER);
  assert.deepEqual([saved.events[0].text, saved.events[0].source], ['Статус: Готово', 'jira']);
});

test('applyJira does not close a direction while a ticket status is unknown', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  const led = await ledDirection(store, 'Сторы', [['APP-1', 'In QA'], ['WEB-2', 'In QA']]);

  await store.applyJira([{ key: 'APP-1', status: 'Closed', segments: [] }, { key: 'WEB-2', status: 'Reopened', segments: [] }], JIRA_LATER);

  const saved = await savedDirection(store, led.id);
  assert.equal(saved.status, 'testing');
  assert.equal(saved.stage, 'testing');
});

test('applyJira leaves a direction without profile project tickets alone', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  const created = await store.createDirection({ title: 'План', ticketKeys: ['CRM-1'] });

  await store.applyJira([{ key: 'CRM-1', status: 'Closed', segments: [] }], JIRA_AT);

  const saved = await savedDirection(store, created.id);
  assert.equal(saved.status, 'in_progress');
  assert.equal(saved.stageFromJira, undefined);
});

test('applyJira upgrades an old file without stage silently', async t => {
  const dataDir = await tempDataDir(t);
  await mkdir(path.join(dataDir, 'directions'));
  const old: Direction = { ...direction('a'), status: 'testing' };
  delete old.waitingFor;
  old.tickets = old.tickets.map(ticket => ({ ...ticket, jira: { status: 'Open', segments: ['EU'], at: JIRA_AT } }));
  await writeFile(path.join(dataDir, 'directions', 'a.json'), JSON.stringify(old));
  const store = new Store(dataDir, { profile: TEST_PROFILE });

  await store.applyJira([], JIRA_LATER);

  const saved = await savedDirection(store, 'a');
  assert.equal(saved.status, 'in_progress');
  assert.equal(saved.stage, 'in_progress');
  assert.equal(saved.stageFromJira, true);
  assert.deepEqual(saved.events.map(e => e.id), ['e1']);
});

test('applyJira fills a ticket added without a profile once the profile knows it', async t => {
  const dataDir = await tempDataDir(t);
  const created = await new Store(dataDir).createDirection({ title: 'Поиск', ticketKeys: ['APP-1'] });
  const store = new Store(dataDir, { profile: TEST_PROFILE });

  await store.applyJira([{ key: 'APP-1', status: 'In QA', segments: [] }], JIRA_AT);

  const saved = await savedDirection(store, created.id);
  assert.deepEqual([saved.tickets[0].platform, saved.tickets[0].url], ['App', 'https://jira.example.com/browse/APP-1']);
  assert.equal(saved.tickets[0].jira?.status, 'In QA');
  assert.equal(saved.stage, 'testing');
});

test('applyJira keeps the platform and link a ticket was stored with', async t => {
  const dataDir = await tempDataDir(t);
  await mkdir(path.join(dataDir, 'directions'));
  const old: Direction = { ...direction('a'), tickets: [{ key: 'APP-2', platform: 'Legacy', url: 'https://old.example.com/browse/APP-2' }] };
  await writeFile(path.join(dataDir, 'directions', 'a.json'), JSON.stringify(old));
  const store = new Store(dataDir, { profile: TEST_PROFILE });

  await store.applyJira([{ key: 'APP-2', status: 'Open', segments: [] }], JIRA_AT);

  const saved = await savedDirection(store, 'a');
  assert.deepEqual([saved.tickets[0].platform, saved.tickets[0].url], ['Legacy', 'https://old.example.com/browse/APP-2']);
});

test('applyJira restages every direction that holds the key', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  const a = await ledDirection(store, 'A', [['APP-1', 'In QA']]);
  const b = await ledDirection(store, 'B', [['APP-1', 'In QA']]);

  await store.applyJira([{ key: 'APP-1', status: 'Open', segments: [] }], JIRA_LATER);

  for (const id of [a.id, b.id]) {
    const saved = await savedDirection(store, id);
    assert.equal(saved.status, 'in_progress', id);
    assert.equal(saved.events.filter(e => e.text === 'Статус: В работе').length, 1, id);
  }
});

test('removeTicket recomputes the stage at once', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  const led = await ledDirection(store, 'SEO', [['APP-1', 'In QA'], ['WEB-2', 'In Review']]);
  assert.equal(led.status, 'in_review');

  await store.removeTicket(led.id, 'WEB-2');

  const saved = await savedDirection(store, led.id);
  assert.equal(saved.status, 'testing');
  assert.deepEqual([saved.events.at(-1)?.text, saved.events.at(-1)?.source], ['Статус: Тестирование', 'jira']);
});

test('setStatus refuses a stage of a Jira-led direction and allows marks and reordering', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  const led = await ledDirection(store, 'SEO', [['APP-1', 'In Review']]);

  await assert.rejects(
    store.setStatus(led.id, 'testing'),
    (error: unknown) => error instanceof ValidationError && error.message === 'Этап направления «SEO» берётся из Jira (сейчас: В мерж реквесте). Можно поставить пометку: wait, parked',
  );
  assert.equal((await store.setStatus(led.id, 'in_review', { index: 0 })).status, 'in_review');
  const waiting = await store.setStatus(led.id, 'waiting', { waitingFor: 'бэк' });
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.stage, 'in_review');
});

test('clearMark returns a direction to its stage column with a clearing event', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  const led = await ledDirection(store, 'Пуши', [['APP-1', 'In QA']], { status: 'waiting', waitingFor: 'девопсы' });

  await store.clearMark(led.id);

  const saved = await savedDirection(store, led.id);
  assert.equal(saved.status, 'testing');
  assert.equal(saved.waitingFor, undefined);
  const last = saved.events.at(-1);
  assert.deepEqual([last?.text, last?.source, last?.kind], ['Больше не жду: девопсы', 'system', 'status']);
});

test('clearMark of a parked direction whose stage is done sends it to done with two events', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  const led = await ledDirection(store, 'Капча', [['APP-1', 'Closed']], { status: 'parked' });
  assert.equal(led.status, 'parked');
  assert.equal(led.stage, 'done');

  await store.clearMark(led.id);

  const saved = await savedDirection(store, led.id);
  assert.equal(saved.status, 'done');
  assert.ok(saved.doneAt !== undefined);
  assert.deepEqual(
    saved.events.slice(-2).map(e => [e.text, e.source]),
    [
      ['Вернул из отложенных', 'system'],
      ['Статус: Готово', 'jira'],
    ],
  );
});

test('a done Jira-led direction takes a mark and goes back to done when it is cleared', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  const led = await ledDirection(store, 'Тапы', [['APP-1', 'Closed']]);
  assert.equal(led.status, 'done');

  const waiting = await store.setStatus(led.id, 'waiting');
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.stage, 'done');
  assert.equal((await store.clearMark(led.id)).status, 'done');
});

test('setStatus of a manual direction from Жду to its own stage clears the mark', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  const created = await store.createDirection({ title: 'Редирект', status: 'waiting', waitingFor: 'девопсы' });

  const moved = await store.setStatus(created.id, 'in_progress');

  assert.equal(moved.status, 'in_progress');
  assert.equal(moved.waitingFor, undefined);
  assert.equal(moved.events.at(-1)?.text, 'Больше не жду: девопсы');
});

test('setStatus of a manual direction sets its stage and keeps it under a mark', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  const created = await store.createDirection({ title: 'Ручное' });

  assert.equal((await store.setStatus(created.id, 'testing')).stage, 'testing');
  const parked = await store.setStatus(created.id, 'parked');
  assert.equal(parked.status, 'parked');
  assert.equal(parked.stage, 'testing');
});

test('setStatus of a manual direction from Жду to its own stage keeps the drop index', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  await store.createDirection({ title: 'Первое' });
  await store.createDirection({ title: 'Второе' });
  const waiting = await store.createDirection({ title: 'Редирект', status: 'waiting', waitingFor: 'девопсы' });

  const moved = await store.setStatus(waiting.id, 'in_progress', { index: 0 });

  assert.equal(moved.status, 'in_progress');
  assert.equal(moved.order, 0);
});

test('importQuickLinks adds only links whose url is missing anywhere', async t => {
  const dataDir = await tempDataDir(t);
  let commits = 0;
  const store = new Store(dataDir, { onCommit: () => commits++ });
  await store.addQuickLink('Моё', { title: 'Почта (моя)', url: 'https://mail.example.com', description: 'своё описание' });
  await store.addQuickLink('Разработка', { title: 'Jenkins', url: 'https://ci.example.com' });
  commits = 0;

  const groups = [
    { title: 'Каждый день', links: [{ title: 'Почта', url: 'https://mail.example.com', description: 'из профиля' }, { title: 'Мои MR', url: 'git.example.com/jdoe' }] },
    { title: 'Разработка', links: [{ title: 'Swagger', url: 'https://api.example.com/swagger' }] },
  ];
  assert.deepEqual(await store.importQuickLinks(groups), { added: 2, present: 1 });
  assert.equal(commits, 1);
  const linkGroups = (await store.read()).linkGroups;
  assert.deepEqual(
    linkGroups.map(g => ({ title: g.title, links: g.links })),
    [
      { title: 'Моё', links: [{ title: 'Почта (моя)', url: 'https://mail.example.com', description: 'своё описание' }] },
      { title: 'Разработка', links: [{ title: 'Jenkins', url: 'https://ci.example.com' }, { title: 'Swagger', url: 'https://api.example.com/swagger' }] },
      { title: 'Каждый день', links: [{ title: 'Мои MR', url: 'https://git.example.com/jdoe' }] },
    ],
  );

  assert.deepEqual(await store.importQuickLinks(groups), { added: 0, present: 3 });
  assert.equal(commits, 1);
});

test('a run without agent reads as claude', async t => {
  const dataDir = await tempDataDir(t);
  await mkdir(path.join(dataDir, 'runs'), { recursive: true });
  const run = { id: 'r1', template: 'execute', directionId: 'd1', branch: 'dev', title: 'x', startedAt: '2026-11-09T10:00:00.000Z' };
  await writeFile(path.join(dataDir, 'runs', 'r1.json'), JSON.stringify(run));
  await writeFile(path.join(dataDir, 'runs', 'r2.json'), JSON.stringify({ ...run, id: 'r2', agent: 'codex' }));
  const runs = (await new Store(dataDir).read()).runs;
  assert.deepEqual(runs.map(r => [r.id, r.agent ?? 'claude']).sort(), [['r1', 'claude'], ['r2', 'codex']]);
});

test('releaseJiraStages hands the stage back when the profile has no Jira', async t => {
  const dataDir = await tempDataDir(t);
  const led = new Store(dataDir, { profile: TEST_PROFILE });
  const dir = await led.createDirection({ title: 'Сторы', ticketKeys: ['APP-1'] });
  await led.applyJira([{ key: 'APP-1', status: 'In QA', segments: [] }], '2026-11-09T10:00:00.000Z');
  assert.equal((await led.read()).directions[0].stageFromJira, true);

  assert.equal(await led.releaseJiraStages(), 0);
  const { jira: _jira, ...noJira } = TEST_PROFILE;
  assert.equal(await new Store(dataDir, { profile: noJira }).releaseJiraStages(), 1);
  const released = (await led.read()).directions.find(d => d.id === dir.id);
  assert.equal(released?.stageFromJira, undefined);
  await new Store(dataDir, { profile: noJira }).setStatus(dir.id, 'done');
});

test('seedExample fills empty data once and never again, even after the example is deleted', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  assert.equal(await store.seedExample(), true);
  const state = await store.read();
  assert.equal(state.directions.length, 1);
  const [example] = state.directions;
  assert.equal(example.example, true);
  assert.deepEqual(state.todos.map(item => item.directionId), [example.id]);
  assert.deepEqual(state.notes.map(note => note.directionIds), [[example.id]]);
  assert.ok(state.onboarding?.exampleCreatedAt);

  assert.equal(await store.seedExample(), false);
  await store.deleteDirection(example.id);
  assert.equal(await store.seedExample(), false);
  assert.deepEqual((await store.read()).directions, []);
});

test('seedExample leaves data with only todos, notes or dailies alone', async t => {
  const withTodo = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  await withTodo.addTodo({ text: 'Дело' });
  const withNote = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  await withNote.createNote({ title: 'Заметка' });
  const withDaily = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  await withDaily.holdDaily({ periodStart: currentPeriodStart(new Date(), []), text: 'Дейлик' });

  for (const store of [withTodo, withNote, withDaily]) {
    assert.equal(await store.seedExample(), false);
    assert.deepEqual((await store.read()).directions, []);
  }
});

test('setOnboarding writes onboarding.json and an empty one is not written', async t => {
  const dir = await tempDataDir(t);
  const store = new Store(dir);
  const closed = await store.setOnboarding({ tourClosed: true, stepsHidden: true });
  assert.match(closed.tourClosedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(closed.stepsHidden, true);
  assert.deepEqual((await store.read()).onboarding, closed);

  await store.setOnboarding({ tourClosed: false, stepsHidden: false });
  await assert.rejects(access(path.join(dir, 'onboarding.json')));
  assert.equal((await store.read()).onboarding, undefined);
});

test('startRun refuses the example and a todo of the example', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  await store.seedExample();
  const { directions, todos } = await store.read();
  const request = { template: 'question' as const, include: [], extra: 'вопрос', branch: 'dev' };
  await assert.rejects(store.startRun({ ...request, directionId: directions[0].id }), /В примере агент не запускается/);
  await assert.rejects(store.startRun({ ...request, todoId: todos[0].id }), /В примере агент не запускается/);
  assert.deepEqual((await store.read()).runs, []);
});

test('deleting the example deletes its todo and note; deleting an own direction only unlinks them', async t => {
  const store = new Store(await tempDataDir(t), { profile: TEST_PROFILE });
  await store.seedExample();
  const own = await store.createDirection({ title: 'Своё' });
  await store.addTodo({ text: 'Своё дело', directionId: own.id });
  await store.createNote({ title: 'Своя заметка', directionIds: [own.id] });
  const example = (await store.read()).directions.find(d => d.example === true);
  assert.ok(example);

  await store.deleteDirection(example.id);
  let state = await store.read();
  assert.deepEqual(state.todos.map(item => item.text), ['Своё дело']);
  assert.deepEqual(state.notes.map(note => note.title), ['Своя заметка']);

  await store.deleteDirection(own.id);
  state = await store.read();
  assert.deepEqual(state.todos.map(item => [item.text, item.directionId]), [['Своё дело', undefined]]);
  assert.deepEqual(state.notes.map(note => note.directionIds), [[]]);
});
