import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PreparedSession } from './sessions.ts';
import { SUMMARY_MARKER, collectSessions, fitToBudget } from './sessions.ts';

const START = '2026-11-04T07:30:00.000Z';
const END = '2026-11-05T08:00:00.000Z';
const IN = '2026-11-05T06:00:00.000Z';

type Line = Record<string, unknown>;

function user(content: unknown, extra: Line = {}): Line {
  return { type: 'user', timestamp: IN, sessionId: 's1', cwd: '/Users/me/Projects/app', gitBranch: 'feature/APP-9355_WEB-5586', isSidechain: false, message: { role: 'user', content }, ...extra };
}

function assistant(content: unknown, extra: Line = {}): Line {
  return { type: 'assistant', timestamp: IN, sessionId: 's1', cwd: '/Users/me/Projects/app', gitBranch: 'feature/APP-9355_WEB-5586', isSidechain: false, message: { role: 'assistant', content }, ...extra };
}

async function projectsDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-sessions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeSession(root: string, project: string, id: string, lines: Line[]): Promise<string> {
  await mkdir(path.join(root, project), { recursive: true });
  const file = path.join(root, project, `${id}.jsonl`);
  await writeFile(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

function texts(session: PreparedSession): string[] {
  return session.messages.map(m => `${m.role}: ${m.text}`);
}

test('keeps user text and assistant text, drops tool calls, thinking and tool results', async t => {
  const root = await projectsDir(t);
  await writeSession(root, '-Users-me-Projects-app', 's1', [
    { type: 'mode', mode: 'normal', sessionId: 's1' },
    user('почини сео'),
    assistant([{ type: 'thinking', thinking: 'хм' }, { type: 'tool_use', name: 'Bash', input: {} }]),
    user([{ type: 'tool_result', content: 'много вывода' }]),
    assistant([{ type: 'text', text: 'Починил: бэк не отдаёт seo_site3.' }]),
    user([{ type: 'text', text: 'спасибо' }]),
  ]);
  const [session] = await collectSessions({ projectsDir: root, start: START, end: END });
  assert.equal(session.sessionId, 's1');
  assert.equal(session.project, '-Users-me-Projects-app');
  assert.deepEqual(texts(session), ['user: почини сео', 'assistant: Починил: бэк не отдаёт seo_site3.', 'user: спасибо']);
});

test('filters messages by period and skips sessions without user messages in it', async t => {
  const root = await projectsDir(t);
  await writeSession(root, 'p', 's1', [user('старое', { timestamp: '2026-11-03T10:00:00.000Z' }), user('новое'), user('будущее', { timestamp: '2026-11-05T09:00:00.000Z' })]);
  await writeSession(root, 'p', 's2', [user('давно', { timestamp: '2026-11-01T10:00:00.000Z', sessionId: 's2' }), assistant([{ type: 'text', text: 'ответ' }], { sessionId: 's2' })]);
  const sessions = await collectSessions({ projectsDir: root, start: START, end: END });
  assert.deepEqual(sessions.map(s => s.sessionId), ['s1']);
  assert.deepEqual(texts(sessions[0]), ['user: новое']);
  assert.equal(sessions[0].firstAt, IN);
  assert.equal(sessions[0].lastAt, IN);
});

test('skips sidechain records, command caveats and system reminders', async t => {
  const root = await projectsDir(t);
  await writeSession(root, 'p', 's1', [
    user('<local-command-caveat>Caveat</local-command-caveat>'),
    user('<command-name>/clear</command-name>'),
    user('<local-command-stdout></local-command-stdout>'),
    user('<task-notification>done</task-notification>'),
    user('<system-reminder>skills</system-reminder>'),
    user('мета', { isMeta: true }),
    user('сбоку', { isSidechain: true }),
    user('реальный вопрос<system-reminder>шум</system-reminder> про сторы'),
  ]);
  const [session] = await collectSessions({ projectsDir: root, start: START, end: END });
  assert.deepEqual(texts(session), ['user: реальный вопрос про сторы']);
});

test('skips subagent transcripts', async t => {
  const root = await projectsDir(t);
  await mkdir(path.join(root, 'p', 's1', 'subagents'), { recursive: true });
  await writeFile(path.join(root, 'p', 's1', 'subagents', 'agent-x.jsonl'), JSON.stringify(user('субагент', { sessionId: 'agent' })) + '\n');
  assert.deepEqual(await collectSessions({ projectsDir: root, start: START, end: END }), []);
});

test('skips sessions containing the summary marker', async t => {
  const root = await projectsDir(t);
  await writeSession(root, 'p', 's1', [user(`${SUMMARY_MARKER}\nТы готовишь материалы`)]);
  assert.deepEqual(await collectSessions({ projectsDir: root, start: START, end: END }), []);
});

test('partial last line and empty project dir are skipped', async t => {
  const root = await projectsDir(t);
  const file = await writeSession(root, 'p', 's1', [user('целое')]);
  await appendFile(file, '{"type":"user","timestamp":"2026-11-05T06:01:00.000Z","mess');
  await mkdir(path.join(root, 'x', 'memory'), { recursive: true });
  const sessions = await collectSessions({ projectsDir: root, start: START, end: END });
  assert.deepEqual(sessions.map(texts), [['user: целое']]);
});

test('missing projects dir gives no sessions', async t => {
  const root = await projectsDir(t);
  assert.deepEqual(await collectSessions({ projectsDir: path.join(root, 'нет'), start: START, end: END }), []);
});

test('collects branches and cwds', async t => {
  const root = await projectsDir(t);
  await writeSession(root, 'p', 's1', [
    user('раз'),
    assistant([{ type: 'text', text: 'два' }], { cwd: '/Users/me/Projects/worklog', gitBranch: 'HEAD' }),
    user('три', { gitBranch: '' }),
  ]);
  const [session] = await collectSessions({ projectsDir: root, start: START, end: END });
  assert.deepEqual(session.branches, ['feature/APP-9355_WEB-5586']);
  assert.deepEqual(session.cwds, ['/Users/me/Projects/app', '/Users/me/Projects/worklog']);
});

test('sessions are ordered by their first message', async t => {
  const root = await projectsDir(t);
  await writeSession(root, 'a', 'late', [user('позже', { sessionId: 'late', timestamp: '2026-11-05T07:00:00.000Z' })]);
  await writeSession(root, 'b', 'early', [user('раньше', { sessionId: 'early', timestamp: '2026-11-04T09:00:00.000Z' })]);
  const sessions = await collectSessions({ projectsDir: root, start: START, end: END });
  assert.deepEqual(sessions.map(s => s.sessionId), ['early', 'late']);
});

function session(id: string, lengths: number[]): PreparedSession {
  return {
    sessionId: id,
    project: 'p',
    cwds: [],
    branches: [],
    firstAt: IN,
    lastAt: IN,
    messages: lengths.map((n, i) => ({ at: IN, role: 'user', text: String(i).padEnd(n, 'x') })),
  };
}

test('fitToBudget cuts long messages and keeps head and tail of a long session', () => {
  const limits = { messageChars: 10, sessionChars: 40, totalChars: 1000 };
  const [cut] = fitToBudget([session('s', [25])], limits);
  assert.equal(cut.messages[0].text, `0${'x'.repeat(9)}…`);

  const [long] = fitToBudget([session('s', [10, 10, 10, 10, 10, 10, 10, 10, 10, 10])], limits);
  assert.deepEqual(
    long.messages.map(m => (m.text.startsWith('[') ? m.text : m.text.charAt(0))),
    ['0', '[… пропущено 7 сообщений …]', '8', '9'],
  );
});

test('fitToBudget shares the total budget between sessions', () => {
  const limits = { messageChars: 10, sessionChars: 1000, totalChars: 40 };
  const fitted = fitToBudget([session('a', [10, 10, 10, 10]), session('b', [10, 10])], limits);
  assert.equal(fitted[0].messages.filter(m => !m.text.startsWith('[')).length, 2);
  assert.equal(fitted[1].messages.length, 2);
});

test('a transcript that vanished after the listing is skipped', async t => {
  const root = await projectsDir(t);
  await writeSession(root, 'p', 's1', [user('живая')]);
  await symlink(path.join(root, 'p', 'удалённый.jsonl'), path.join(root, 'p', 'gone.jsonl'));
  const sessions = await collectSessions({ projectsDir: root, start: START, end: END });
  assert.deepEqual(sessions.map(s => s.sessionId), ['s1']);
});
