import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { homedir } from 'node:os';
import { MAX_SUMMARY_TIMEOUT_MS, parseEnvFile, readEnvFile, settingProblem, withEnvValue } from './env-file.ts';

test('parseEnvFile keeps the value verbatim after the first =', () => {
  assert.deepEqual(parseEnvFile('WORKLOG_CODE_ROOT=/Users/x/My Projects/a=b\n'), { WORKLOG_CODE_ROOT: '/Users/x/My Projects/a=b' });
});

test('parseEnvFile skips comments, blank and foreign lines, the last line wins', () => {
  assert.deepEqual(parseEnvFile('# x\n\nPATH=/bin\nWORKLOG_EDITOR=vscode\r\nWORKLOG_EDITOR=cursor\n'), { WORKLOG_EDITOR: 'cursor' });
});

test('readEnvFile gives nothing without a file', async (t: TestContext) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(readEnvFile(path.join(dir, 'env')), {});
});

test('parseEnvFile drops one pair of surrounding quotes and expands a leading ~/', () => {
  assert.deepEqual(parseEnvFile('WORKLOG_CODE_ROOT="/Users/x/My Projects/app"\nWORKLOG_CLAUDE_BIN=~/.local/bin/claude\nWORKLOG_EDITOR_BIN=\'/opt/it\'s\'\n'), {
    WORKLOG_CODE_ROOT: '/Users/x/My Projects/app',
    WORKLOG_CLAUDE_BIN: path.join(homedir(), '.local/bin/claude'),
    WORKLOG_EDITOR_BIN: "/opt/it's",
  });
});

test('parseEnvFile refuses a line it would otherwise drop silently', () => {
  for (const line of ['export WORKLOG_EDITOR=vscode', 'WORKLOG_TERMINAL = iterm', 'WORKLOG_CODE_ROOT']) {
    assert.throws(() => parseEnvFile(`# ok\n${line}\n`), { message: `Не понял строку 2 файла настроек: ${line} (нужно WORKLOG_ИМЯ=значение)` }, line);
  }
});

test('withEnvValue replaces the first line of a name and drops its repeats', () => {
  const text = '# мой\nWORKLOG_EDITOR=vscode\nWORKLOG_PORT=1\nWORKLOG_EDITOR=cursor\n';
  assert.equal(withEnvValue(text, 'WORKLOG_EDITOR', 'jetbrains'), '# мой\nWORKLOG_EDITOR=jetbrains\nWORKLOG_PORT=1\n');
});

test('withEnvValue appends a missing name and removes one set to empty', () => {
  assert.equal(withEnvValue('', 'WORKLOG_TERMINAL', 'warp'), 'WORKLOG_TERMINAL=warp\n');
  assert.equal(withEnvValue('# x\n\nWORKLOG_PORT=1', 'WORKLOG_TERMINAL', 'warp'), '# x\n\nWORKLOG_PORT=1\nWORKLOG_TERMINAL=warp\n');
  assert.equal(withEnvValue('WORKLOG_TERMINAL=warp\nWORKLOG_PORT=1\n', 'WORKLOG_TERMINAL', ''), 'WORKLOG_PORT=1\n');
  assert.equal(withEnvValue('WORKLOG_TERMINAL=warp\n', 'WORKLOG_TERMINAL', ''), '');
});

test('withEnvValue keeps a value with spaces, = and quotes readable as is', () => {
  for (const value of ['/a b/c=d', '"x"', "'y'", "it's", '"half']) {
    assert.equal(parseEnvFile(withEnvValue('', 'WORKLOG_CODE_ROOT', value)).WORKLOG_CODE_ROOT, value);
  }
});

test('withEnvValue refuses a value with a line break', () => {
  assert.throws(() => withEnvValue('', 'WORKLOG_CODE_ROOT', '/a\nWORKLOG_PORT=1'), /перенос строки/);
});

test('settingProblem takes decimal digits within the limit and named choices only', () => {
  for (const raw of ['0x10', '1e3', '-1', ' 1', '1.5', '70000']) assert.match(settingProblem('WORKLOG_PORT', raw) ?? '', /до 65535/);
  assert.equal(settingProblem('WORKLOG_PORT', '65535'), null);
  assert.equal(settingProblem('WORKLOG_IDLE_MS', 'soon'), 'нужно целое число');
  assert.notEqual(settingProblem('WORKLOG_SUMMARY_TIMEOUT_MS', String(MAX_SUMMARY_TIMEOUT_MS + 1)), null);
  assert.equal(settingProblem('WORKLOG_TERMINAL', 'termnal'), 'warp, iterm, terminal');
  assert.equal(settingProblem('WORKLOG_CODE_ROOT', 'Projects/app'), 'нужен полный путь');
  assert.equal(settingProblem('WORKLOG_CLAUDE_BIN', 'claude'), null);
});
