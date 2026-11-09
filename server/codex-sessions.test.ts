import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectCodexSessions } from './codex-sessions.ts';
import { SUMMARY_MARKER } from './sessions.ts';

const START = '2026-03-02T08:00:00.000Z';
const END = '2026-03-03T08:00:00.000Z';
const AT = '2026-03-02T10:00:00.000Z';

async function sessionsDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-codex-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function meta(cwd = '/Users/me/Projects/app', branch = 'feature/APP-1') {
  return { timestamp: AT, type: 'session_meta', payload: { id: 'c1', cwd, git: { branch } } };
}

function message(role: string, text: string, at = AT) {
  const type = role === 'assistant' ? 'output_text' : 'input_text';
  return { timestamp: at, type: 'response_item', payload: { type: 'message', role, content: [{ type, text }] } };
}

async function rollout(dir: string, name: string, lines: unknown[], raw = ''): Promise<void> {
  const day = path.join(dir, '2026', '03', '02');
  await mkdir(day, { recursive: true });
  await writeFile(path.join(day, `rollout-2026-03-02T10-00-00-${name}.jsonl`), `${lines.map(line => JSON.stringify(line)).join('\n')}\n${raw}`);
}

test('collectCodexSessions reads user and assistant messages of the period', async t => {
  const dir = await sessionsDir(t);
  await rollout(dir, 'a', [
    meta(),
    message('developer', 'служебное'),
    message('user', 'Почини редирект', '2026-03-02T10:01:00.000Z'),
    { timestamp: AT, type: 'response_item', payload: { type: 'reasoning', summary: [] } },
    { timestamp: AT, type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'ls' } },
    message('assistant', 'Поправил условие в guard', '2026-03-02T10:05:00.000Z'),
    message('user', 'вне периода', '2026-03-04T10:00:00.000Z'),
  ]);
  assert.deepEqual(await collectCodexSessions({ sessionsDir: dir, start: START, end: END }), [
    {
      sessionId: 'c1',
      project: '-Users-me-Projects-app',
      cwds: ['/Users/me/Projects/app'],
      branches: ['feature/APP-1'],
      firstAt: '2026-03-02T10:01:00.000Z',
      lastAt: '2026-03-02T10:05:00.000Z',
      messages: [
        { at: '2026-03-02T10:01:00.000Z', role: 'user', text: 'Почини редирект' },
        { at: '2026-03-02T10:05:00.000Z', role: 'assistant', text: 'Поправил условие в guard' },
      ],
    },
  ]);
});

test('collectCodexSessions drops injected context and empty sessions', async t => {
  const dir = await sessionsDir(t);
  await rollout(dir, 'a', [
    meta(),
    message('user', '<environment_context>\n  <cwd>/x</cwd>\n</environment_context>'),
    message('user', '# AGENTS.md instructions for /x\n\nправила'),
    message('user', '<turn_aborted>\nThe user interrupted</turn_aborted>'),
    message('assistant', 'Готов'),
  ]);
  assert.deepEqual(await collectCodexSessions({ sessionsDir: dir, start: START, end: END }), []);
});

test('collectCodexSessions skips broken lines and a file without session_meta', async t => {
  const dir = await sessionsDir(t);
  await rollout(dir, 'a', [meta(), message('user', 'Сделай ревью')], '{"timestamp":"2026-03-02T10:09');
  await rollout(dir, 'b', [message('user', 'Без шапки')]);
  const sessions = await collectCodexSessions({ sessionsDir: dir, start: START, end: END });
  assert.deepEqual(
    sessions.map(s => [s.project, s.messages.map(m => m.text)]),
    [
      ['-Users-me-Projects-app', ['Сделай ревью']],
      ['codex', ['Без шапки']],
    ],
  );
  assert.deepEqual(await collectCodexSessions({ sessionsDir: path.join(dir, 'missing'), start: START, end: END }), []);
});

test('collectCodexSessions skips a marked summary session', async t => {
  const dir = await sessionsDir(t);
  await rollout(dir, 'a', [meta(), message('user', `${SUMMARY_MARKER}\nсобери дейлик`), message('assistant', '{}')]);
  assert.deepEqual(await collectCodexSessions({ sessionsDir: dir, start: START, end: END }), []);
});
