import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

test('summary timeout above the stale limit is refused', () => {
  const script = "await import('./server/config.ts')";
  const env = { ...process.env, WORKLOG_SUMMARY_TIMEOUT_MS: '400000' };
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: path.resolve(import.meta.dirname, '..'), env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Некорректное значение WORKLOG_SUMMARY_TIMEOUT_MS: 400000/);
});

test('Jira files and the profile default to ~/.config/worklog', () => {
  const script = "const c = await import('./server/config.ts'); console.log(JSON.stringify({ ...c.JIRA_FILES, pollMs: c.JIRA_POLL_MS, profile: c.PROFILE_PATH }))";
  const env = Object.fromEntries(Object.entries({ ...process.env, HOME: '/Users/someone' }).filter(([name]) => !name.startsWith('WORKLOG_JIRA_') && name !== 'WORKLOG_PROFILE' && name !== 'WORKLOG_ENV_FILE'));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: path.resolve(import.meta.dirname, '..'), env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    p12Path: '/Users/someone/.config/worklog/jira.p12',
    caPath: '/Users/someone/.config/worklog/jira-ca.crt',
    keychainService: 'worklog-jira-p12',
    tokenService: 'worklog-jira-token',
    pollMs: 300000,
    profile: '/Users/someone/.config/worklog/profile.json',
  });
});

const CONFIG_KEYS = ['WORKLOG_CODE_ROOT', 'WORKLOG_EDITOR', 'WORKLOG_EDITOR_BIN', 'WORKLOG_TERMINAL', 'WORKLOG_CLAUDE_BIN', 'WORKLOG_CODEX_BIN', 'WORKLOG_AGENT', 'WORKLOG_ENV_FILE'];

function configIn(envFile: string, extra: Record<string, string> = {}) {
  const script = "const c = await import('./server/config.ts'); console.log(JSON.stringify({ codeRoot: c.CODE_ROOT ?? null, editor: c.EDITOR, editorBin: c.EDITOR_BIN, terminal: c.TERMINAL, agents: c.AGENT_SETUP }))";
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !CONFIG_KEYS.includes(name)));
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...base, WORKLOG_ENV_FILE: envFile, ...extra },
    encoding: 'utf8',
  });
}

function tempEnvFile(text: string | null): { file: string; done: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'worklog-config-'));
  const file = path.join(dir, 'env');
  if (text !== null) writeFileSync(file, text);
  return { file, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('config prefers the environment over the env file over the default', t => {
  const env = tempEnvFile('WORKLOG_CODE_ROOT=/from/file\nWORKLOG_EDITOR=vscode\n');
  t.after(env.done);
  const result = configIn(env.file, { WORKLOG_EDITOR: 'cursor' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { codeRoot: '/from/file', editor: 'cursor', editorBin: 'cursor', terminal: 'terminal', agents: { main: 'claude', bins: { claude: 'claude' } } });
});

test('config leaves the code root unset without env', t => {
  const env = tempEnvFile(null);
  t.after(env.done);
  const result = configIn(env.file);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { codeRoot: null, editor: 'jetbrains', editorBin: 'webstorm', terminal: 'terminal', agents: { main: 'claude', bins: { claude: 'claude' } } });
});

test('config refuses an unknown terminal or editor', t => {
  const env = tempEnvFile('WORKLOG_TERMINAL=termnal\n');
  t.after(env.done);
  const terminal = configIn(env.file);
  assert.notEqual(terminal.status, 0);
  assert.match(terminal.stderr, /Некорректное значение WORKLOG_TERMINAL: termnal/);
  const editor = configIn(env.file, { WORKLOG_TERMINAL: 'warp', WORKLOG_EDITOR: 'vim' });
  assert.notEqual(editor.status, 0);
  assert.match(editor.stderr, /Некорректное значение WORKLOG_EDITOR: vim/);
});

test('config refuses a relative code root', t => {
  const env = tempEnvFile('WORKLOG_CODE_ROOT=Projects/app\n');
  t.after(env.done);
  const result = configIn(env.file);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Некорректное значение WORKLOG_CODE_ROOT: Projects\/app \(нужен полный путь\)/);
});

test('the test run never reads the real env file', () => {
  assert.notEqual(process.env.WORKLOG_ENV_FILE, undefined);
  assert.notEqual(path.resolve(process.env.WORKLOG_ENV_FILE ?? ''), path.join(homedir(), '.config', 'worklog', 'env'));
});
