import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TEST_PROFILE } from '../shared/test-profile.ts';
import { Store } from '../server/store.ts';
import { runCli } from './commands.ts';
import { runSetup } from './setup.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'worklog');

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function runBin(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(BIN, args, { env: { ...process.env, WORKLOG_NODE: process.execPath, ...env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => (stdout += chunk));
  child.stderr.on('data', chunk => (stderr += chunk));
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  return { code, stdout, stderr };
}

test('config set writes the env file and refuses an unknown name or value', async t => {
  const dir = await tempDir(t);
  const envFile = path.join(dir, 'config', 'env');
  const set = await runSetup(['config', 'set', 'WORKLOG_TERMINAL', 'warp'], { envFile });
  assert.equal(set.code, 0, set.stderr);
  assert.equal(await readFile(envFile, 'utf8'), 'WORKLOG_TERMINAL=warp\n');
  assert.equal((await stat(envFile)).mode & 0o777, 0o600);

  const unknown = await runSetup(['config', 'set', 'WORKLOG_TERMNAL', 'warp'], { envFile });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Неизвестная настройка WORKLOG_TERMNAL/);
  const terminal = await runSetup(['config', 'set', 'WORKLOG_TERMINAL', 'termnal'], { envFile });
  assert.equal(terminal.code, 1);
  assert.match(terminal.stderr, /warp, iterm, terminal/);
  const editor = await runSetup(['config', 'set', 'WORKLOG_EDITOR', 'vim'], { envFile });
  assert.equal(editor.code, 1);
  assert.match(editor.stderr, /jetbrains, vscode, cursor/);
  const agent = await runSetup(['config', 'set', 'WORKLOG_AGENT', 'gpt'], { envFile });
  assert.equal(agent.code, 1);
  assert.match(agent.stderr, /claude, codex/);
  const relative = await runSetup(['config', 'set', 'WORKLOG_CODE_ROOT', 'Projects/app'], { envFile });
  assert.equal(relative.code, 1);
  assert.equal(await readFile(envFile, 'utf8'), 'WORKLOG_TERMINAL=warp\n');
});

test('config set works while the env file has a bad value', async t => {
  const dir = await tempDir(t);
  const envFile = path.join(dir, 'env');
  await writeFile(envFile, 'WORKLOG_TERMINAL=termnal\n');
  const env = { WORKLOG_ENV_FILE: envFile, WORKLOG_DATA_DIR: dir, WORKLOG_PROFILE: path.join(dir, 'missing-profile.json') };

  const broken = await runBin(['state'], env);
  assert.equal(broken.code, 1);
  assert.match(broken.stderr, /WORKLOG_TERMINAL: termnal/);
  assert.match(broken.stderr, /worklog doctor/);

  const fixed = await runBin(['config', 'set', 'WORKLOG_TERMINAL', 'warp'], env);
  assert.equal(fixed.code, 0, fixed.stderr);
  assert.equal(await readFile(envFile, 'utf8'), 'WORKLOG_TERMINAL=warp\n');
  const state = await runBin(['state'], env);
  assert.equal(state.code, 0, state.stderr);
});

test('worklog without arguments lists setup commands', async t => {
  const result = await runCli([], { dataDir: await tempDir(t) });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /worklog config set <NAME> <value>/);
  assert.match(result.stderr, /worklog doctor \[--json\]/);
});

async function profileEnv(t: TestContext) {
  const dir = await tempDir(t);
  return { dir, dataDir: path.join(dir, 'data'), envFile: path.join(dir, 'config', 'env'), profilePath: path.join(dir, 'config', 'profile.json') };
}

test('profile fetch keeps the old profile and source when the new one is invalid', async t => {
  const env = await profileEnv(t);
  const good = path.join(env.dir, 'good.json');
  await writeFile(good, JSON.stringify(TEST_PROFILE));
  const fetched = await runCli(['profile', 'fetch', good], env);
  assert.equal(fetched.code, 0, fetched.stderr);
  assert.match(fetched.stdout, /Профиль сохранён: .*profile\.json, версия 1/);

  const newer = path.join(env.dir, 'newer.json');
  await writeFile(newer, JSON.stringify({ ...TEST_PROFILE, version: 99 }));
  const refused = await runCli(['profile', 'fetch', newer], env);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /обнови worklog/);
  const broken = path.join(env.dir, 'broken.json');
  await writeFile(broken, '{');
  assert.match((await runCli(['profile', 'fetch', broken], env)).stderr, /не JSON/);

  assert.equal(await readFile(env.profilePath, 'utf8'), JSON.stringify(TEST_PROFILE));
  assert.equal(await readFile(env.envFile, 'utf8'), `WORKLOG_PROFILE_SOURCE=${good}\n`);
});

test('profile fetch --from records the link as the source', async t => {
  const env = await profileEnv(t);
  const downloaded = path.join(env.dir, 'downloaded.json');
  await writeFile(downloaded, JSON.stringify(TEST_PROFILE));
  const link = 'https://git.example.com/team/docs/-/blob/main/p.json';
  const fetched = await runCli(['profile', 'fetch', '--from', downloaded, link], env);
  assert.equal(fetched.code, 0, fetched.stderr);
  assert.equal(await readFile(env.envFile, 'utf8'), `WORKLOG_PROFILE_SOURCE=${link}\n`);
  const nonsense = await runCli(['profile', 'fetch', '--from', downloaded, 'docs/p.json'], env);
  assert.equal(nonsense.code, 1);
  assert.match(nonsense.stderr, /Не понял источник профиля/);
});

test('profile check reports whether the saved profile fits this version', async t => {
  const env = await profileEnv(t);
  const none = await runCli(['profile', 'check'], env);
  assert.deepEqual([none.code, none.stdout], [0, 'Профиля нет\n']);

  await mkdir(path.dirname(env.profilePath), { recursive: true });
  await writeFile(env.profilePath, JSON.stringify(TEST_PROFILE));
  const fits = await runCli(['profile', 'check'], env);
  assert.deepEqual([fits.code, fits.stdout], [0, 'Профиль в порядке\n']);

  await writeFile(env.profilePath, JSON.stringify({ ...TEST_PROFILE, version: 0 }));
  const old = await runCli(['profile', 'check'], env);
  assert.equal(old.code, 3);
  assert.match(old.stderr, /обнови профиль/);

  await writeFile(env.profilePath, '{');
  assert.equal((await runCli(['profile', 'check'], env)).code, 1);
});

test('profile update without a source says how to set one', async t => {
  const result = await runCli(['profile', 'update'], await profileEnv(t));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /worklog profile fetch/);
});

test('quicklink import reports added, present and skipped', async t => {
  const { dataDir } = await profileEnv(t);
  const withLogin = await runCli(['quicklink', 'import'], { dataDir, profile: TEST_PROFILE, gitlabUser: 'jdoe' });
  assert.equal(withLogin.stdout, 'Ссылки из профиля: добавлено 1, уже были 0\n');
  assert.equal((await new Store(dataDir).read()).linkGroups[0].links[0].url, 'https://git.example.com/jdoe');

  const withoutLogin = await runCli(['quicklink', 'import'], { dataDir, profile: TEST_PROFILE });
  assert.equal(withoutLogin.stdout, 'Ссылки из профиля: добавлено 0, уже были 0\nПропущены (нет WORKLOG_GITLAB_USER): Мои MR\n');
  const noProfile = await runCli(['quicklink', 'import'], { dataDir });
  assert.equal(noProfile.code, 1);
  assert.match(noProfile.stderr, /Нет профиля компании/);
});

test('data commit prints the hash or that there is nothing to commit', async t => {
  const { dataDir } = await profileEnv(t);
  assert.match((await runCli(['data', 'init'], { dataDir })).stdout, /Свой git данных заведён/);
  assert.match((await runCli(['data', 'init'], { dataDir })).stdout, /уже есть/);
  assert.equal((await runCli(['data', 'commit'], { dataDir })).stdout, 'Нечего коммитить: данные не менялись\n');
  await runCli(['todo', 'add', 'Позвонить'], { dataDir });
  assert.match((await runCli(['data', 'commit', '--message', 'Дело'], { dataDir })).stdout, /^Данные закоммичены: [0-9a-f]+\n$/);
});

test('doctor --json prints checks and exits 1 on a failure', async t => {
  const dir = await tempDir(t);
  const result = await runBin(['doctor', '--json'], {
    WORKLOG_ENV_FILE: path.join(dir, 'missing-env'),
    WORKLOG_PROFILE: path.join(dir, 'missing-profile.json'),
    WORKLOG_DATA_DIR: path.join(dir, 'data'),
    WORKLOG_CHROME_DIR: dir,
    WORKLOG_PORT: '1',
    CLAUDE_SKILLS_DIR: path.join(dir, 'skills'),
    CODEX_SKILLS_DIR: path.join(dir, 'agent-skills'),
    CODEX_HOME: path.join(dir, 'codex'),
    WORKLOG_BIN_DIR: path.join(dir, 'bin'),
  });
  assert.equal(result.code, 1, result.stderr);
  const report: { ok: boolean; checks: { id: string; status: string }[] } = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  const status = Object.fromEntries(report.checks.map(item => [item.id, item.status]));
  assert.equal(status['code-root'], 'fail');
  assert.equal(status['data'], 'fail');
  assert.equal(status['profile'], 'warn');
  assert.equal(status['jira'], 'skip');
});

test('doctor shows a broken env instead of failing', async t => {
  const dir = await tempDir(t);
  const envFile = path.join(dir, 'env');
  await writeFile(envFile, 'WORKLOG_TERMINAL=termnal\n');
  const result = await runBin(['doctor'], { WORKLOG_ENV_FILE: envFile, WORKLOG_PROFILE: path.join(dir, 'missing-profile.json'), WORKLOG_DATA_DIR: dir });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /✗ env: Некорректное значение WORKLOG_TERMINAL: termnal/);
  assert.match(result.stdout, /✓ git:/);
});
