import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Direction, Note, RepeatRule, Todo, WorklogState } from '../shared/model.ts';
import { Store } from '../server/store.ts';
import { snss } from '../server/chrome-tabs.fixture.ts';
import { runCli } from './commands.ts';
import { TEST_PROFILE } from '../shared/test-profile.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'worklog');

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function parsed<T>(text: string): T {
  return JSON.parse(text);
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    result[path.relative(dir, file)] = await readFile(file, 'utf8');
  }
  return result;
}

test('dir add with tickets then state lists it under В работе', async t => {
  const dataDir = await tempDir(t);
  const added = await runCli(['dir', 'add', 'Фильтры', '--ticket', 'app-7301', '--ticket', 'WEB-4410'], { dataDir });
  assert.equal(added.code, 0);
  assert.match(added.stdout.trim(), /^[0-9a-z]+$/);

  const state = await runCli(['state'], { dataDir });
  assert.equal(state.code, 0);
  assert.match(state.stdout, /● В работе \(1\)\n {2}Фильтры · APP-7301 WEB-4410\n/);

  const json = await runCli(['state', '--json'], { dataDir });
  assert.equal(parsed<WorklogState>(json.stdout).directions[0].title, 'Фильтры');
});

test('state shows waiting, open todo count, parked and open todos', async t => {
  const dataDir = await tempDir(t);
  const store = new Store(dataDir, { profile: TEST_PROFILE });
  const direction = await store.createDirection({ title: 'Ждущее', status: 'waiting', waitingFor: 'девопсы' });
  await store.createDirection({ title: 'Позже', status: 'parked' });
  await store.addTodo({ text: 'Позвонить', directionId: direction.id, requestedBy: 'Олег' });

  const { stdout } = await runCli(['state'], { dataDir });
  assert.match(stdout, /● Жду \(1\)\n {2}Ждущее · жду: девопсы · этап: В работе · дел: 1\n/);
  assert.match(stdout, /Отложено \(1\)\n {2}Позже · этап: В работе\n/);
  assert.match(stdout, /Дела \(1\)\n {2}[0-9a-z]+ {2}Позвонить · Ждущее · от Олег\n/);
});

test('state marks the example', async t => {
  const dataDir = await tempDir(t);
  await new Store(dataDir, { profile: TEST_PROFILE }).seedExample();
  const { stdout } = await runCli(['state'], { dataDir });
  assert.match(stdout, /Пример: карта пунктов выдачи · APP-1001 WEB-1002 · дел: 1 · пример\n/);
});

test('note list and search mark the note of the example', async t => {
  const dataDir = await tempDir(t);
  await new Store(dataDir, { profile: TEST_PROFILE }).seedExample();
  const listed = await runCli(['note', 'list'], { dataDir });
  assert.match(listed.stdout, /Ключ карты на стендах · пример\n/);
  const found = await runCli(['note', 'list', '--search', 'карт'], { dataDir });
  assert.match(found.stdout, /Ключ карты на стендах · пример\n/);
});

test('dir status wait --waiting shows Жду · who in dir show', async t => {
  const dataDir = await tempDir(t);
  const { stdout: id } = await runCli(['dir', 'add', 'Деплой'], { dataDir });
  const changed = await runCli(['dir', 'status', 'деплой', 'wait', '--waiting', 'девопсы'], { dataDir });
  assert.equal(changed.code, 0);

  const shown = await runCli(['dir', 'show', id.trim()], { dataDir });
  assert.equal(shown.code, 0);
  assert.ok(shown.stdout.includes('Жду · девопсы'), shown.stdout);

  const bad = await runCli(['dir', 'status', id.trim(), 'nonsense'], { dataDir });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /nonsense/);
});

async function jiraLedDirection(dataDir: string, title: string): Promise<Direction> {
  const store = new Store(dataDir, { profile: TEST_PROFILE });
  const created = await store.createDirection({ title, ticketKeys: ['APP-1'] });
  await store.applyJira([{ key: 'APP-1', status: 'In Review', segments: [] }], '2026-11-06T09:00:00.000Z');
  return created;
}

test('dir status of a Jira-led direction prints the refusal and exits 1', async t => {
  const dataDir = await tempDir(t);
  await jiraLedDirection(dataDir, 'Сео');
  const result = await runCli(['dir', 'status', 'сео', 'test'], { dataDir });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /берётся из Jira \(сейчас: В мерж реквесте\)/);
});

test('dir unmark clears Жду', async t => {
  const dataDir = await tempDir(t);
  await new Store(dataDir, { profile: TEST_PROFILE }).createDirection({ title: 'Ждущее', status: 'waiting', waitingFor: 'девопсы' });
  const result = await runCli(['dir', 'unmark', 'ждущее'], { dataDir });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'Ждущее: В работе');
});

test('dir show prints the stage and where it comes from', async t => {
  const dataDir = await tempDir(t);
  await jiraLedDirection(dataDir, 'Сео');
  await new Store(dataDir, { profile: TEST_PROFILE }).createDirection({ title: 'Сертификат' });
  assert.ok((await runCli(['dir', 'show', 'сео'], { dataDir })).stdout.includes('\nЭтап: В мерж реквесте (Jira)\n'));
  assert.ok((await runCli(['dir', 'show', 'сертификат'], { dataDir })).stdout.includes('\nЭтап: В работе (вручную)'));
});

test('dir done-at sets the done date of a done direction', async t => {
  const dataDir = await tempDir(t);
  await runCli(['dir', 'add', 'Промо', '--status', 'done'], { dataDir });
  const set = await runCli(['dir', 'done-at', 'промо', '2026-04-09'], { dataDir });
  assert.equal(set.code, 0, set.stderr);
  assert.equal(set.stdout.trim(), 'Промо: сделано 2026-04-09');
  const [direction] = parsed<WorklogState>((await runCli(['state', '--json'], { dataDir })).stdout).directions;
  assert.ok(direction.doneAt !== undefined);
  assert.equal(new Date(direction.doneAt).getMonth(), 3);

  await runCli(['dir', 'add', 'Фильтры'], { dataDir });
  const notDone = await runCli(['dir', 'done-at', 'фильтры', '2026-04-09'], { dataDir });
  assert.notEqual(notDone.code, 0);
  assert.match(notDone.stderr, /Направление не в статусе «Готово»/);
});

test('dir done-at by name prefers the done direction over an active one with a similar title', async t => {
  const dataDir = await tempDir(t);
  const { stdout: doneId } = await runCli(['dir', 'add', 'Промокоды в боттомшите', '--status', 'done', '--ticket', 'APP-5563'], { dataDir });
  await runCli(['dir', 'add', 'Промокоды v2', '--ticket', 'APP-5563'], { dataDir });
  for (const ref of ['промокоды', 'APP-5563']) {
    const set = await runCli(['dir', 'done-at', ref, '2026-04-09'], { dataDir });
    assert.equal(set.code, 0, set.stderr);
    assert.equal(set.stdout.trim(), 'Промокоды в боттомшите: сделано 2026-04-09');
  }
  const { directions } = parsed<WorklogState>((await runCli(['state', '--json'], { dataDir })).stdout);
  assert.equal(directions.find(d => d.id === doneId.trim())?.doneAt !== undefined, true);
});

test('dir rename and dir rm', async t => {
  const dataDir = await tempDir(t);
  const { stdout: id } = await runCli(['dir', 'add', 'Старое'], { dataDir });
  assert.equal((await runCli(['dir', 'rename', id.trim(), 'Новое'], { dataDir })).code, 0);
  assert.equal((await new Store(dataDir, { profile: TEST_PROFILE }).read()).directions[0].title, 'Новое');
  assert.equal((await runCli(['dir', 'rm', 'Новое'], { dataDir })).code, 0);
  assert.deepEqual((await new Store(dataDir, { profile: TEST_PROFILE }).read()).directions, []);
});

test('event by ticket key lands in the direction with that ticket', async t => {
  const dataDir = await tempDir(t);
  await runCli(['dir', 'add', 'Фильтры', '--ticket', 'APP-7301'], { dataDir });
  await runCli(['dir', 'add', 'Другое', '--ticket', 'APP-1'], { dataDir });

  const result = await runCli(['event', 'app-7301', 'Олег подтвердил баг бэка'], { dataDir });
  assert.equal(result.code, 0);

  const { directions } = await new Store(dataDir, { profile: TEST_PROFILE }).read();
  const target = directions.find(d => d.title === 'Фильтры');
  assert.equal(target?.events.length, 1);
  assert.equal(target?.events[0].text, 'Олег подтвердил баг бэка');
  assert.equal(target?.events[0].source, 'claude');
  assert.equal(directions.find(d => d.title === 'Другое')?.events.length, 0);

  await runCli(['event', 'APP-7301', 'сам записал', '--source', 'manual'], { dataDir });
  const after = (await new Store(dataDir, { profile: TEST_PROFILE }).read()).directions.find(d => d.title === 'Фильтры');
  assert.equal(after?.events[1].source, 'manual');

  const invalid = await runCli(['event', 'APP-7301', 'x', '--source', 'system'], { dataDir });
  assert.equal(invalid.code, 1);
});

test('ambiguous ref exits 1 with candidates and writes nothing', async t => {
  const dataDir = await tempDir(t);
  await runCli(['dir', 'add', 'Сео главная'], { dataDir });
  await runCli(['dir', 'add', 'Сео каталог'], { dataDir });
  const before = await snapshot(dataDir);

  const result = await runCli(['event', 'сео', 'что-то'], { dataDir });
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('Сео главная'), result.stderr);
  assert.ok(result.stderr.includes('Сео каталог'), result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(await snapshot(dataDir), before);
});

for (const argv of [
  ['todo', 'add', 'Дело', '--dir', 'сео'],
  ['dir', 'rm', 'сео'],
  ['dir', 'status', 'сео', 'done'],
  ['ticket', 'add', 'сео', 'APP-1'],
  ['link', 'add', 'сео', 'https://x.test/a'],
]) {
  test(`ambiguous ref in «${argv.join(' ')}» writes nothing`, async t => {
    const dataDir = await tempDir(t);
    await runCli(['dir', 'add', 'Сео главная'], { dataDir });
    await runCli(['dir', 'add', 'Сео каталог'], { dataDir });
    const before = await snapshot(dataDir);

    const result = await runCli(argv, { dataDir });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Неоднозначно/);
    assert.deepEqual(await snapshot(dataDir), before);
  });
}

test('todo add --dir --from then done writes a todo-done event', async t => {
  const dataDir = await tempDir(t);
  const { stdout: id } = await runCli(['dir', 'add', 'Фильтры', '--ticket', 'APP-7301'], { dataDir });
  const added = await runCli(['todo', 'add', 'Проверить фильтры', '--dir', 'APP-7301', '--from', 'Олег', '--due', '2026-11-10'], { dataDir });
  assert.equal(added.code, 0);

  const list = await runCli(['todo', 'list', '--json'], { dataDir });
  const [todo] = parsed<Todo[]>(list.stdout);
  assert.equal(todo.directionId, id.trim());
  assert.equal(todo.requestedBy, 'Олег');
  assert.equal(todo.due, '2026-11-10');

  assert.equal((await runCli(['todo', 'done', todo.id], { dataDir })).code, 0);
  const done = (await new Store(dataDir, { profile: TEST_PROFILE }).read()).directions[0];
  assert.deepEqual(
    done.events.map(e => e.kind),
    ['todo-done'],
  );

  assert.equal((await runCli(['todo', 'undo', todo.id], { dataDir })).code, 0);
  const undone = await new Store(dataDir, { profile: TEST_PROFILE }).read();
  assert.equal(undone.todos[0].done, false);
  assert.deepEqual(undone.directions[0].events, []);

  const text = await runCli(['todo', 'list'], { dataDir });
  assert.match(text.stdout, /\[ \] .*Проверить фильтры/);
});

test('ticket and link commands', async t => {
  const dataDir = await tempDir(t);
  await runCli(['dir', 'add', 'Фильтры'], { dataDir });
  assert.equal((await runCli(['ticket', 'add', 'фильтры', 'web-4410'], { dataDir })).code, 0);
  assert.equal((await runCli(['link', 'add', 'фильтры', 'https://figma.com/file/1', '--title', 'Макет'], { dataDir })).code, 0);
  assert.equal((await runCli(['link', 'add', 'фильтры', 'https://x.test/a', '--kind', 'branch'], { dataDir })).code, 0);

  const shown = await runCli(['dir', 'show', 'WEB-4410', '--json'], { dataDir });
  const { direction } = parsed<{ direction: Direction; todos: Todo[] }>(shown.stdout);
  assert.deepEqual(direction.tickets.map(x => x.key), ['WEB-4410']);
  assert.deepEqual(direction.links.map(x => x.kind), ['figma', 'branch']);

  const text = await runCli(['dir', 'show', 'фильтры'], { dataDir });
  assert.ok(text.stdout.includes('WEB-4410') && text.stdout.includes('Макет'), text.stdout);

  assert.equal((await runCli(['ticket', 'rm', 'фильтры', 'WEB-4410'], { dataDir })).code, 0);
  assert.equal((await runCli(['link', 'rm', 'фильтры', 'https://x.test/a'], { dataDir })).code, 0);
  const after = (await new Store(dataDir, { profile: TEST_PROFILE }).read()).directions[0];
  assert.deepEqual(after.tickets, []);
  assert.deepEqual(after.links.map(l => l.url), ['https://figma.com/file/1']);
});

test('dir show lists only the last 10 events', async t => {
  const dataDir = await tempDir(t);
  const { stdout: id } = await runCli(['dir', 'add', 'Лента'], { dataDir });
  for (let i = 1; i <= 12; i++) await runCli(['event', id.trim(), `событие-${i}`], { dataDir });
  const { stdout } = await runCli(['dir', 'show', id.trim()], { dataDir });
  const shown = new Set(stdout.split('\n').flatMap(line => line.split(' · ')).filter(part => part.startsWith('событие-')));
  const expected = new Set(Array.from({ length: 10 }, (_, i) => `событие-${i + 3}`));
  assert.deepEqual(shown, expected);
});

test('quicklink add and rm match the group title case-insensitively', async t => {
  const dataDir = await tempDir(t);
  await runCli(['quicklink', 'add', 'Jira', 'Борда', 'https://jr.test/board'], { dataDir });
  await runCli(['quicklink', 'add', 'jira', 'Фильтр', 'https://jr.test/filter'], { dataDir });
  const state = await new Store(dataDir, { profile: TEST_PROFILE }).read();
  assert.equal(state.linkGroups.length, 1);
  assert.deepEqual(state.linkGroups[0].links.map(l => l.title), ['Борда', 'Фильтр']);

  assert.equal((await runCli(['quicklink', 'rm', 'JIRA', 'https://jr.test/board'], { dataDir })).code, 0);
  assert.equal((await new Store(dataDir, { profile: TEST_PROFILE }).read()).linkGroups[0].links.length, 1);

  const missing = await runCli(['quicklink', 'rm', 'Нет такой', 'https://jr.test/filter'], { dataDir });
  assert.equal(missing.code, 1);
});

test('removing the last quick link keeps the group; quicklink group-rm deletes it', async t => {
  const dataDir = await tempDir(t);
  await runCli(['quicklink', 'add', 'Jira', 'Борда', 'https://jr.test/board'], { dataDir });
  await runCli(['quicklink', 'rm', 'Jira', 'https://jr.test/board'], { dataDir });
  assert.deepEqual(
    (await new Store(dataDir, { profile: TEST_PROFILE }).read()).linkGroups.map(g => [g.title, g.links.length]),
    [['Jira', 0]],
  );

  const removed = await runCli(['quicklink', 'group-rm', 'jira'], { dataDir });
  assert.equal(removed.code, 0, removed.stderr);
  assert.deepEqual((await new Store(dataDir, { profile: TEST_PROFILE }).read()).linkGroups, []);
  assert.equal((await runCli(['quicklink', 'group-rm', 'Jira'], { dataDir })).code, 1);
});

test('unknown command exits 2 with usage', async t => {
  const dataDir = await tempDir(t);
  const result = await runCli(['frobnicate'], { dataDir });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /frobnicate/);
  assert.match(result.stderr, /worklog state/);

  assert.equal((await runCli([], { dataDir })).code, 2);
  assert.equal((await runCli(['dir', 'frobnicate'], { dataDir })).code, 2);
});

test('missing arguments exit 1 with a usage line', async t => {
  const dataDir = await tempDir(t);
  const result = await runCli(['event', 'only-ref'], { dataDir });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /event <ref> <text>/);
});

test('missing arguments print the full usage line with options', async t => {
  const dataDir = await tempDir(t);
  const result = await runCli(['dir', 'add'], { dataDir });
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('Использование: worklog dir add <title> [--status S] [--ticket KEY]... [--waiting WHO]'), result.stderr);
});

test('text starting with a dash gets a hint and goes through after --', async t => {
  const dataDir = await tempDir(t);
  const { stdout: id } = await runCli(['dir', 'add', 'Баги'], { dataDir });

  const refused = await runCli(['event', id.trim(), '-5 багов'], { dataDir });
  assert.equal(refused.code, 1);
  assert.ok(refused.stderr.includes('Текст, начинающийся с «-», передайте после --'), refused.stderr);

  const written = await runCli(['event', id.trim(), '--', '-5 багов'], { dataDir });
  assert.equal(written.code, 0, written.stderr);
  assert.deepEqual((await new Store(dataDir, { profile: TEST_PROFILE }).read()).directions[0].events.map(e => e.text), ['-5 багов']);
});

async function runBin(env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(BIN, ['state'], { env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => (stdout += chunk));
  child.stderr.on('data', chunk => (stderr += chunk));
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  return { code, stdout, stderr };
}

function withoutNode(dataDir: string, envFile: string): Record<string, string> {
  const base = Object.fromEntries(Object.entries(process.env).flatMap(([name, value]) => (value === undefined || name === 'WORKLOG_NODE' ? [] : [[name, value]])));
  return { ...base, HOME: dataDir, PATH: '/usr/bin:/bin', WORKLOG_DATA_DIR: dataDir, WORKLOG_PROFILE: path.join(dataDir, 'missing-profile.json'), WORKLOG_ENV_FILE: envFile };
}

test('bin/worklog finds node in the env file', async t => {
  const dataDir = await tempDir(t);
  const envFile = path.join(dataDir, 'env');
  await writeFile(envFile, `WORKLOG_NODE=${process.execPath}\n`);
  const result = await runBin(withoutNode(dataDir, envFile));
  assert.equal(result.code, 0, result.stderr);
});

test('bin/worklog reads a quoted node path from the env file', async t => {
  const dataDir = await tempDir(t);
  const envFile = path.join(dataDir, 'env');
  await writeFile(envFile, `WORKLOG_NODE="${process.execPath}"\r\n`);
  const result = await runBin(withoutNode(dataDir, envFile));
  assert.equal(result.code, 0, result.stderr);
});

test('bin/worklog says where to set node when there is none', async t => {
  const dataDir = await tempDir(t);
  const result = await runBin(withoutNode(dataDir, path.join(dataDir, 'missing-env')));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /WORKLOG_NODE/);
});

test('bin/worklog state runs', async t => {
  const dataDir = await tempDir(t);
  const child = spawn(BIN, ['state'], {
    env: { ...process.env, WORKLOG_DATA_DIR: dataDir, WORKLOG_NODE: process.execPath, WORKLOG_PROFILE: path.join(dataDir, 'missing-profile.json'), WORKLOG_ENV_FILE: path.join(dataDir, 'missing-env') },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => (stdout += chunk));
  child.stderr.on('data', chunk => (stderr += chunk));
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  assert.equal(code, 0, stderr);
  assert.ok(stdout.length > 0);
});

test('daily show prints period and template text', async t => {
  const dataDir = await tempDir(t);
  await runCli(['dir', 'add', 'Фильтры', '--ticket', 'APP-6120'], { dataDir });
  await runCli(['event', 'APP-6120', 'Разобрал localStorage'], { dataDir });
  await runCli(['dir', 'add', 'Сертификат', '--status', 'wait', '--waiting', 'девопсы'], { dataDir });
  const shown = await runCli(['daily', 'show'], { dataDir });
  assert.equal(shown.code, 0);
  const [head, blank, ...rest] = shown.stdout.trimEnd().split('\n');
  assert.match(head, /^Дейлик · период с \d\d\.\d\d 11:30$/);
  assert.equal(blank, '');
  assert.deepEqual(rest, ['Касаемо задачи «Фильтры»: Разобрал localStorage.', '1. APP-6120', '', 'Жду: Сертификат — девопсы']);
  const asJson = parsed<{ periodStart: string; text: string; waiting: { title: string; waitingFor: string | null }[] }>((await runCli(['daily', 'show', '--json'], { dataDir })).stdout);
  assert.equal(asJson.text, 'Касаемо задачи «Фильтры»: Разобрал localStorage.\n1. APP-6120');
  assert.deepEqual(asJson.waiting.map(w => [w.title, w.waitingFor]), [['Сертификат', 'девопсы']]);
});

async function chromeWithTabs(t: TestContext, tabs: Parameters<typeof snss>[0]): Promise<string> {
  const chromeDir = await tempDir(t);
  const sessions = path.join(chromeDir, 'Default', 'Sessions');
  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(sessions, 'Session_1'), snss(tabs));
  return chromeDir;
}

test('tabs groups open Chrome tabs by direction, then unknown keys, then the rest', async t => {
  const dataDir = await tempDir(t);
  const id = (await runCli(['dir', 'add', 'SEO', '--ticket', 'APP-7301'], { dataDir, profile: TEST_PROFILE })).stdout.trim();
  await runCli(['link', 'add', id, 'https://wiki.test/brd?id=1', '--title', 'BRD'], { dataDir });
  const chromeDir = await chromeWithTabs(t, [
    { id: 1, window: 1, index: 0, url: 'https://jira.example.com/browse/APP-7301', title: '[APP-7301] SEO-текст' },
    { id: 2, window: 1, index: 1, url: 'https://jira.example.com/login?os_destination=CRM-14964', title: 'Вход' },
    { id: 3, window: 1, index: 2, url: 'https://wiki.test/brd?id=1', title: 'BRD' },
  ]);

  const text = await runCli(['tabs'], { dataDir, chromeDir });
  assert.equal(text.code, 0, text.stderr);
  assert.equal(
    text.stdout,
    [
      'Вкладок: 3',
      '',
      `SEO · ${id}`,
      '  [APP-7301] SEO-текст',
      '    https://jira.example.com/browse/APP-7301 · сохранена',
      '  BRD',
      '    https://wiki.test/brd?id=1 · сохранена',
      '',
      'Номера без направления',
      '  CRM-14964 · Вход',
      '    https://jira.example.com/login?os_destination=CRM-14964',
      '',
    ].join('\n'),
  );

  const json = await runCli(['tabs', '--json'], { dataDir, chromeDir });
  const tabs = parsed<{ url: string; keys: string[]; directions: { id: string }[]; saved: boolean }[]>(json.stdout);
  assert.deepEqual(tabs[0].directions.map(d => d.id), [id]);
  assert.equal(tabs[1].saved, false);
});

test('tabs fails with the folder it looked in when Chrome has no session', async t => {
  const dataDir = await tempDir(t);
  const chromeDir = await tempDir(t);
  const result = await runCli(['tabs'], { dataDir, chromeDir });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Не нашёл файл сессии Chrome/);
  assert.equal((await runCli(['tabs'], { dataDir })).code, 1);
  await assert.rejects(access(path.join(dataDir, 'onboarding.json')));
});

test('tabs marks the onboarding once the tabs are read', async t => {
  const dataDir = await tempDir(t);
  const chromeDir = await chromeWithTabs(t, [{ id: 1, window: 1, index: 0, url: 'https://wiki.example.com/x', title: 'X' }]);
  const readAt = async () => parsed<{ tabsReadAt?: string }>(await readFile(path.join(dataDir, 'onboarding.json'), 'utf8')).tabsReadAt;

  assert.equal((await runCli(['tabs'], { dataDir, chromeDir })).code, 0);
  const first = await readAt();
  assert.match(first ?? '', /^\d{4}-\d{2}-\d{2}T/);
  assert.equal((await runCli(['tabs'], { dataDir, chromeDir })).code, 0);
  assert.equal((await runCli(['tabs', '--json'], { dataDir, chromeDir })).code, 0);
  assert.equal(await readAt(), first);
});

test('note add, show, list, edit and rm work by id or title part', async t => {
  const dataDir = await tempDir(t);
  const codeRoot = await tempDir(t);
  await mkdir(path.join(codeRoot, 'libs'));
  await writeFile(path.join(codeRoot, 'libs', 'README.md'), '');
  const env = { dataDir, codeRoot };
  await runCli(['dir', 'add', 'US пуши', '--ticket', 'APP-9508'], env);

  const added = await runCli(
    ['note', 'add', 'Общий origin', '--body', 'Ключи `app.*`\nне переименовывать', '--dir', 'APP-9508', '--link', 'libs/README.md', '--link', 'push.ts:42', '--link', 'https://wiki.test/p BRD'],
    env,
  );
  assert.equal(added.code, 0, added.stderr);
  const id = added.stdout.trim();

  const shown = await runCli(['note', 'show', 'origin'], env);
  assert.equal(
    shown.stdout,
    [`Общий origin`, `id: ${id}`, 'Направления: US пуши', '', 'Ключи `app.*`', 'не переименовывать', '', 'Ссылки:', '  libs/README.md', '  push.ts:42 · ✗ файла нет', '  https://wiki.test/p BRD', ''].join('\n'),
  );
  assert.match((await runCli(['note', 'list', '--search', 'пуши'], env)).stdout, new RegExp(`^${id}  Общий origin · битых ссылок: 1\n$`));
  assert.equal((await runCli(['note', 'list', '--search', 'карта'], env)).stdout, 'Заметок нет\n');
  assert.equal((await runCli(['note', 'check'], env)).stdout, `${id}  Общий origin\n  ✗ push.ts:42\n`);
  assert.match((await runCli(['dir', 'show', 'US'], env)).stdout, new RegExp(`Заметки \\(note show <id>\\):\n  ${id}  Общий origin`));

  assert.equal((await runCli(['note', 'edit', id, '--title', 'Origin', '--no-links', '--no-dirs'], env)).code, 0);
  const note = parsed<{ note: Note }>((await runCli(['note', 'show', id, '--json'], env)).stdout).note;
  assert.deepEqual({ title: note.title, files: note.files, urls: note.urls, directionIds: note.directionIds }, { title: 'Origin', files: [], urls: [], directionIds: [] });
  assert.equal((await runCli(['note', 'check'], env)).stdout, 'Все ссылки на файлы живые\n');

  assert.match((await runCli(['note', 'add', 'x', '--link', '../etc'], env)).stderr, /Не понял ссылку/);
  assert.equal((await runCli(['note', 'rm', 'Origin'], env)).stdout, 'Удалена: Origin\n');
  assert.match((await runCli(['note', 'show', 'Origin'], env)).stderr, /Заметка не найдена/);
});

test('link and quicklink descriptions are set, shown and cleared', async t => {
  const dataDir = await tempDir(t);
  await runCli(['dir', 'add', 'Кадры'], { dataDir });
  await runCli(['link', 'add', 'Кадры', 'https://docs.example.com/', '--title', 'КЭДО', '--desc', 'Кадровые документы'], { dataDir });
  assert.equal((await runCli(['link', 'desc', 'Кадры', 'docs.example.com/', 'Отпуска\nсправки'], { dataDir })).stdout, 'Описание: КЭДО\n');
  assert.match((await runCli(['dir', 'show', 'Кадры'], { dataDir })).stdout, /КЭДО · https:\/\/docs\.example\.com\/ · other\n {4}Отпуска\n {4}справки\n/);
  assert.equal((await runCli(['link', 'desc', 'Кадры', 'https://docs.example.com/', ''], { dataDir })).stdout, 'Описание убрано: КЭДО\n');

  await runCli(['quicklink', 'add', 'Корпоративное', 'КЭДО', 'https://docs.example.com/', '--desc', 'Подписать'], { dataDir });
  assert.equal((await runCli(['quicklink', 'desc', 'корпоративное', 'https://docs.example.com/', 'Логин корпоративный'], { dataDir })).code, 0);
  const groups = parsed<WorklogState>((await runCli(['state', '--json'], { dataDir })).stdout).linkGroups;
  assert.equal(groups[0].links[0].description, 'Логин корпоративный');
});

test('agent list shows running agents and agent done takes the mark off', async t => {
  const dataDir = await tempDir(t);
  const store = new Store(dataDir, { profile: TEST_PROFILE });
  const direction = await store.createDirection({ title: 'Фильтры' });
  const { run } = await store.startRun({ template: 'decompose', directionId: direction.id, include: [], extra: '', branch: 'feature/APP-1' });

  const list = await runCli(['agent', 'list'], { dataDir });
  assert.equal(list.code, 0);
  assert.match(list.stdout, new RegExp(`^${run.id} {2}Фильтры · декомпозировать · feature/APP-1 · с \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}\n$`));
  assert.equal(parsed<unknown[]>((await runCli(['agent', 'list', '--json'], { dataDir })).stdout).length, 1);

  const done = await runCli(['agent', 'done', run.id], { dataDir });
  assert.equal(done.stdout, 'Отметка снята: Фильтры · декомпозировать\n');
  assert.equal((await runCli(['agent', 'list'], { dataDir })).stdout, 'Агенты не работают\n');
  assert.equal((await runCli(['agent', 'done', 'nope'], { dataDir })).code, 1);
  assert.equal((await runCli(['agent', 'done'], { dataDir })).code, 1);
});

test('repeat add makes today\'s todo at once; list, state and rm', async t => {
  const dataDir = await tempDir(t);
  const added = await runCli(['repeat', 'add', 'Проверить почту', '--every', 'day'], { dataDir });
  assert.equal(added.code, 0, added.stderr);
  assert.match(added.stdout, /Проверить почту · каждый день · дело на сегодня добавлено/);
  const [id] = added.stdout.split(' ');

  const state = await runCli(['state'], { dataDir });
  assert.match(state.stdout, /Проверить почту · до \d{4}-\d{2}-\d{2} · ↻ каждый день/);
  assert.match((await runCli(['repeat', 'list'], { dataDir })).stdout.trim(), new RegExp(`^${id}  Проверить почту · каждый день$`));

  const bad = await runCli(['repeat', 'add', 'Встреча', '--every', 'monday'], { dataDir });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Не понял дни: monday/);
  assert.equal((await runCli(['repeat', 'add', 'Встреча'], { dataDir })).code, 1);

  assert.match((await runCli(['repeat', 'rm', id], { dataDir })).stdout, /Повтор убран: Проверить почту/);
  assert.equal((await runCli(['repeat', 'list'], { dataDir })).stdout.trim(), 'Повторяющихся дел нет');
  const [todo] = parsed<Todo[]>((await runCli(['todo', 'list', '--json'], { dataDir })).stdout);
  assert.equal(todo.text, 'Проверить почту');
  assert.equal(todo.repeatId, undefined);
});

test('todo and repeat take --link and --time; todo edit and repeat edit change or remove them', async t => {
  const dataDir = await tempDir(t);
  const id = (await runCli(['todo', 'add', 'Звонок', '--link', 'meet.example.com/f416', '--time', '12.00'], { dataDir })).stdout.trim();
  assert.match((await runCli(['todo', 'list'], { dataDir })).stdout, /Звонок · в 12:00 · https:\/\/meet\.example\.com\/f416/);
  const edited = await runCli(['todo', 'edit', id, '--no-link', '--time', '13:30'], { dataDir });
  assert.equal(edited.code, 0, edited.stderr);
  const [todo] = parsed<Todo[]>((await runCli(['todo', 'list', '--json'], { dataDir })).stdout);
  assert.deepEqual([todo.url, todo.time], [undefined, '13:30']);
  assert.equal((await runCli(['todo', 'edit', id], { dataDir })).code, 1);
  assert.equal((await runCli(['todo', 'edit', id, '--link', 'x.ru', '--no-link'], { dataDir })).code, 1);

  const added = await runCli(['repeat', 'add', 'Платформенный звонок', '--every', 'fri', '--time', '12:00', '--link', 'meet.example.com/f416'], { dataDir });
  assert.equal(added.code, 0, added.stderr);
  const [ruleId] = added.stdout.split(' ');
  assert.match((await runCli(['repeat', 'list'], { dataDir })).stdout, /Платформенный звонок · по пятницам · в 12:00 · https:\/\/meet\.example\.com\/f416/);
  const ruleEdit = await runCli(['repeat', 'edit', ruleId, '--no-time'], { dataDir });
  assert.equal(ruleEdit.code, 0, ruleEdit.stderr);
  assert.match(ruleEdit.stdout, /Платформенный звонок · по пятницам/);
  const [rule] = parsed<RepeatRule[]>((await runCli(['repeat', 'list', '--json'], { dataDir })).stdout);
  assert.equal(rule.time, undefined);
  assert.equal((await runCli(['repeat', 'edit', ruleId, '--time', '12'], { dataDir })).code, 1);
});
