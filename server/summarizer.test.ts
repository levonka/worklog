import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Direction, WorkEvent } from '../shared/model.ts';
import { periodDigest, ticketFromKey } from '../shared/model.ts';
import type { PreparedSession } from './sessions.ts';
import { SUMMARY_MARKER } from './sessions.ts';
import { buildSummaryPrompt, directionHints, parseSummary, runClaude, runCodex, runSummaryAgent, stopSummaryRuns } from './summarizer.ts';
import { TEST_PROFILE } from '../shared/test-profile.ts';

const at = (day: number, hour: number, minute = 0): string => new Date(2026, 10, day, hour, minute).toISOString();

function direction(id: string, title: string, keys: string[], patch: Partial<Direction> = {}): Direction {
  return { id, title, status: 'in_progress', tickets: keys.map(key => ticketFromKey(key, TEST_PROFILE)), links: [], events: [], order: 0, createdAt: at(1, 9), updatedAt: at(1, 9), ...patch };
}

function session(id: string, patch: Partial<PreparedSession> = {}): PreparedSession {
  return {
    sessionId: id,
    project: '-Users-me-Projects-app',
    cwds: ['/Users/me/Projects/app'],
    branches: [],
    firstAt: at(5, 9),
    lastAt: at(5, 10, 15),
    messages: [
      { at: at(5, 9), role: 'user', text: 'почему нет seo_site3?' },
      { at: at(5, 10, 15), role: 'assistant', text: 'Бэк не отдаёт поле.' },
    ],
    ...patch,
  };
}

const seo = direction('seo', 'SEO-текст на страницах матчей', ['APP-9355', 'WEB-5586'], {
  status: 'waiting',
  waitingFor: 'бэк',
  events: [{ id: 'e', at: at(4, 14), text: 'Олег подтвердил баг бэка', source: 'manual', kind: 'note' } satisfies WorkEvent],
});
const done = direction('old', 'Старое', [], { status: 'done' });

test('buildSummaryPrompt starts with the marker and lists sessions, directions, events and today', () => {
  const state = { directions: [seo, done], todos: [], repeats: [], linkGroups: [], dailies: [], draft: null, notes: [], runs: [] };
  const prompt = buildSummaryPrompt({
    periodStart: at(4, 11, 30),
    periodEnd: at(5, 11),
    sessions: [session('s1', { branches: ['feature/APP-9355_WEB-5586'] })],
    directions: state.directions,
    digest: periodDigest(state, at(4, 11, 30), null, '2026-11-05'),
  });
  assert.ok(prompt.startsWith(`${SUMMARY_MARKER}\n`));
  assert.ok(prompt.includes('за период 04.11 11:30 — 05.11 11:00'));
  assert.ok(prompt.includes('- id=seo · «SEO-текст на страницах матчей» · Жду · жду: бэк · задачи: APP-9355, WEB-5586'));
  assert.ok(!prompt.includes('«Старое»'));
  assert.ok(prompt.includes('- «SEO-текст на страницах матчей» · 04.11 14:00 · Олег подтвердил баг бэка'));
  assert.ok(prompt.includes('На сегодня:\n- нет'));
  assert.ok(prompt.includes('=== sessionId=s1 · 05.11 09:00–05.11 10:15 · ветки: feature/APP-9355_WEB-5586 · подсказка: «SEO-текст на страницах матчей» ==='));
  assert.ok(prompt.includes('[он] почему нет seo_site3?\n[помощник] Бэк не отдаёт поле.'));
  assert.ok(prompt.includes('Касаемо задачи по поиску - была проблема'));
  assert.ok(prompt.includes('без «мы»: «договорился», «завёл», а не «договорились», «заведём»'));
});

test('buildSummaryPrompt marks Jira events and gives their neutral phrase', () => {
  const unify = direction('u', 'Унификация', ['APP-1'], {
    status: 'testing',
    events: [{ id: 'j', at: at(4, 15), text: 'Статус: Тестирование', source: 'jira', kind: 'status' } satisfies WorkEvent],
  });
  const state = { directions: [seo, unify], todos: [], repeats: [], linkGroups: [], dailies: [], draft: null, notes: [], runs: [] };
  const prompt = buildSummaryPrompt({ periodStart: at(4, 11, 30), periodEnd: at(5, 11), sessions: [], directions: state.directions, digest: periodDigest(state, at(4, 11, 30), null, '2026-11-05') });
  assert.ok(prompt.includes('- «Унификация» · 04.11 15:00 · [Jira] Ушла в тестирование'));
  assert.ok(!prompt.includes('Статус: Тестирование'));
  assert.ok(prompt.includes('- «SEO-текст на страницах матчей» · 04.11 14:00 · Олег подтвердил баг бэка'));
  assert.ok(prompt.includes('с пометкой [Jira] сделал не он'));
});

test('directionHints finds ticket keys in branches and messages', () => {
  const stores = direction('st', 'Сторы', ['APP-9618']);
  assert.deepEqual(directionHints(session('s', { branches: ['feature/APP-9355_WEB-5586'] }), [seo, stores]).map(d => d.id), ['seo']);
  const mention = session('s', { messages: [{ at: at(5, 9), role: 'user', text: 'посмотри app-9618' }] });
  assert.deepEqual(directionHints(mention, [seo, stores]).map(d => d.id), ['st']);
  const lookalike = session('s', { messages: [{ at: at(5, 9), role: 'user', text: 'APP-96180' }] });
  assert.deepEqual(directionHints(lookalike, [stores]), []);
});

async function stub(t: TestContext, body: string): Promise<{ bin: string; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-claude-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'claude');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = path.dirname(process.argv[1]);
fs.writeFileSync(path.join(dir, 'argv.json'), JSON.stringify(process.argv.slice(2)));
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(dir, 'stdin.txt'), input);
  ${body}
});
`;
  await writeFile(bin, script);
  await chmod(bin, 0o755);
  return { bin, dir };
}

const options = (bin: string, timeoutMs = 5000) => ({ bin, model: 'sonnet', cwd: tmpdir(), timeoutMs });

test('runClaude passes flags and prompt via stdin and returns structured_output', async t => {
  const { bin, dir } = await stub(t, `process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '{}', structured_output: { prose: 'ok' } }));`);
  assert.deepEqual(await runClaude('промпт', options(bin)), { prose: 'ok' });
  const argv: string[] = JSON.parse(await readFile(path.join(dir, 'argv.json'), 'utf8'));
  assert.equal(argv[0], '-p');
  assert.equal(argv[argv.indexOf('--model') + 1], 'sonnet');
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'json');
  assert.ok(argv.includes('--no-session-persistence'));
  assert.equal(argv[argv.indexOf('--tools') + 1], '');
  assert.equal(argv[argv.indexOf('--setting-sources') + 1], '');
  assert.ok(argv.includes('--disable-slash-commands'));
  assert.ok(argv.includes('--strict-mcp-config'));
  assert.equal(JSON.parse(argv[argv.indexOf('--json-schema') + 1]).type, 'object');
  assert.equal(await readFile(path.join(dir, 'stdin.txt'), 'utf8'), 'промпт');
});

test('runClaude reports a missing binary', async () => {
  await assert.rejects(runClaude('x', options('/нет/claude')), { message: 'Не найден claude: /нет/claude' });
});

test('runClaude reports a non-zero exit with the stderr tail', async t => {
  const { bin } = await stub(t, `process.stderr.write('шум\\nНе авторизован\\n\\n'); process.exit(3);`);
  await assert.rejects(runClaude('x', options(bin)), { message: 'claude завершился с кодом 3: Не авторизован' });
});

test('runClaude kills a run that does not finish in time', async t => {
  const { bin } = await stub(t, `setTimeout(() => {}, 60000);`);
  await assert.rejects(runClaude('x', options(bin, 300)), { message: 'Сборка из сессий не уложилась в 0.3 с' });
});

test('runClaude reports is_error', async t => {
  const { bin } = await stub(t, `process.stdout.write(JSON.stringify({ is_error: true, result: 'Credit balance is too low' }));`);
  await assert.rejects(runClaude('x', options(bin)), { message: 'claude: Credit balance is too low' });
});

test('runClaude reports an answer without structure', async t => {
  const plain = await stub(t, `process.stdout.write('не json');`);
  await assert.rejects(runClaude('x', options(plain.bin)), { message: 'claude вернул ответ без структуры' });
  const bare = await stub(t, `process.stdout.write(JSON.stringify({ is_error: false, result: 'текст' }));`);
  await assert.rejects(runClaude('x', options(bare.bin)), { message: 'claude вернул ответ без структуры' });
});

test('parseSummary drops unknown sessions, nulls unknown directions, caps items at 3, empty prose → null', () => {
  const sessions = [session('s1'), session('s2', { lastAt: at(5, 10, 40) })];
  const output = {
    sessions: [
      { sessionId: 's1', directionId: 'seo', items: ['раз', ' ', 'два', 'три', 'четыре'] },
      { sessionId: 's2', directionId: 'gone', items: ['вне'] },
      { sessionId: 'чужая', directionId: null, items: ['лишнее'] },
    ],
    todoCandidates: [
      { sessionId: 's1', text: 'Завести задачу бэку', requestedBy: 'Олега', directionId: 'gone' },
      { sessionId: 's1', text: '  ', requestedBy: null, directionId: null },
    ],
    prose: '   ',
  };
  const { summary, prose } = parseSummary(output, sessions, new Set(['seo']), new Date(2026, 10, 5, 11));
  assert.equal(prose, null);
  assert.equal(summary.sessionCount, 2);
  assert.equal(summary.ranAt, new Date(2026, 10, 5, 11).toISOString());
  assert.deepEqual(
    summary.items.map(i => [i.sessionId, i.directionId, i.text, i.at]),
    [
      ['s1', 'seo', 'раз', at(5, 10, 15)],
      ['s1', 'seo', 'два', at(5, 10, 15)],
      ['s1', 'seo', 'три', at(5, 10, 15)],
      ['s2', null, 'вне', at(5, 10, 40)],
    ],
  );
  assert.deepEqual(
    summary.candidates.map(c => [c.text, c.requestedBy, c.directionId]),
    [['Завести задачу бэку', 'Олега', null]],
  );
  assert.equal(new Set([...summary.items, ...summary.candidates].map(x => x.id)).size, 5);
});

test('parseSummary rejects an answer of the wrong shape', () => {
  assert.throws(() => parseSummary({ prose: 'x' }, [], new Set(), new Date()), { message: 'claude вернул ответ без структуры' });
});

test('runClaude reads claude’s own error from stdout on a non-zero exit', async t => {
  const limited = await stub(t, `process.stdout.write(JSON.stringify({ is_error: true, result: 'Usage limit reached' })); process.exit(1);`);
  await assert.rejects(runClaude('x', options(limited.bin)), { message: 'claude: Usage limit reached' });
  const silent = await stub(t, `process.exit(1);`);
  await assert.rejects(runClaude('x', options(silent.bin)), { message: 'claude завершился с кодом 1: нет вывода' });
});

test('the prompt forbids AI words in items and candidates too', () => {
  const state = { directions: [], todos: [], repeats: [], linkGroups: [], dailies: [], draft: null, notes: [], runs: [] };
  const prompt = buildSummaryPrompt({ periodStart: at(4, 11, 30), periodEnd: at(5, 11), sessions: [], directions: [], digest: periodDigest(state, at(4, 11, 30), null, '2026-11-05') });
  assert.ok(prompt.includes('Во всех текстах (items, todoCandidates, prose) — никаких упоминаний помощника, ИИ, Claude, агентов, сессий, переписки, генерации: всё сделал он сам.'));
});

test('stopSummaryRuns kills a running claude', async t => {
  const { bin } = await stub(t, `setTimeout(() => {}, 60000);`);
  const run = runClaude('x', options(bin));
  await new Promise(resolve => setTimeout(resolve, 200));
  stopSummaryRuns();
  await assert.rejects(run, { message: 'Сборка остановлена: сервер выключился' });
});

/** a fake codex: writes the answer file named after -o; `answer` is JS that yields the text, or null for no file */
const codexBody = (answer: string, code = 0) => `
  const out = process.argv[process.argv.indexOf('-o') + 1];
  const schema = process.argv[process.argv.indexOf('--output-schema') + 1];
  fs.writeFileSync(path.join(dir, 'schema.json'), fs.readFileSync(schema));
  const text = ${answer};
  if (text !== null) fs.writeFileSync(out, text);
  if (${code} !== 0) { process.stderr.write('boom\\nusage limit reached'); }
  process.exit(${code});
`;

test('runCodex passes the prompt on stdin and reads the answer file', async t => {
  const { bin, dir } = await stub(t, codexBody(`JSON.stringify({ prose: 'ok' })`));
  assert.deepEqual(await runCodex('промпт', { bin, cwd: tmpdir(), timeoutMs: 5000 }), { prose: 'ok' });
  const argv: string[] = JSON.parse(await readFile(path.join(dir, 'argv.json'), 'utf8'));
  assert.deepEqual(argv.slice(0, 6), ['exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '-s', 'read-only']);
  const folder = argv[argv.indexOf('-C') + 1];
  assert.notEqual(folder, tmpdir());
  assert.equal(path.dirname(argv[argv.indexOf('-o') + 1]), folder);
  assert.equal(argv.at(-1), '-');
  assert.equal(argv.includes('-m'), false);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'schema.json'), 'utf8')).type, 'object');
  assert.equal(await readFile(path.join(dir, 'stdin.txt'), 'utf8'), 'промпт');

  await runCodex('x', { bin, model: 'gpt-5.5', cwd: tmpdir(), timeoutMs: 5000 });
  const withModel: string[] = JSON.parse(await readFile(path.join(dir, 'argv.json'), 'utf8'));
  assert.deepEqual(withModel.slice(-3), ['-m', 'gpt-5.5', '-']);
});

test('runCodex reports a missing binary, a failed run and an answer without structure', async t => {
  await assert.rejects(runCodex('x', { bin: '/нет/codex', cwd: tmpdir(), timeoutMs: 5000 }), { message: 'Не найден codex: /нет/codex' });
  const failed = await stub(t, codexBody('null', 1));
  await assert.rejects(runCodex('x', { bin: failed.bin, cwd: tmpdir(), timeoutMs: 5000 }), { message: 'codex завершился с кодом 1: usage limit reached' });
  const silent = await stub(t, codexBody('null'));
  await assert.rejects(runCodex('x', { bin: silent.bin, cwd: tmpdir(), timeoutMs: 5000 }), { message: 'codex вернул ответ без структуры' });
  const text = await stub(t, codexBody(`'not json'`));
  await assert.rejects(runCodex('x', { bin: text.bin, cwd: tmpdir(), timeoutMs: 5000 }), { message: 'codex вернул ответ без структуры' });
});

test('runSummaryAgent picks the agent', async t => {
  const codex = await stub(t, codexBody(`JSON.stringify({ by: 'codex' })`));
  assert.deepEqual(await runSummaryAgent('x', { agent: 'codex', bin: codex.bin, cwd: tmpdir(), timeoutMs: 5000 }), { by: 'codex' });
  const claude = await stub(t, `process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '{}', structured_output: { by: 'claude' } }));`);
  assert.deepEqual(await runSummaryAgent('x', { agent: 'claude', bin: claude.bin, cwd: tmpdir(), timeoutMs: 5000 }), { by: 'claude' });
});
