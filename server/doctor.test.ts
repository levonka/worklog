import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Profile } from '../shared/model.ts';
import { TEST_PROFILE } from '../shared/test-profile.ts';
import { initDataRepo } from './data-git.ts';
import type { Check, CheckId, DoctorConfig, DoctorMachine, DoctorProbes } from './doctor.ts';
import { formatChecks, runDoctor, worklogHealth } from './doctor.ts';
import type { JiraRequest } from './jira.ts';

const { jira: _jira, ...NO_JIRA } = TEST_PROFILE;

interface Rig {
  machine: DoctorMachine;
  config: DoctorConfig;
  probes: DoctorProbes;
  root: string;
}

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-doctor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function executable(file: string): Promise<string> {
  await writeFile(file, '#!/bin/sh\n');
  await chmod(file, 0o755);
  return file;
}

/** a machine where everything is in place; the profile has no Jira unless given one */
async function rig(t: TestContext, profile: Profile | null = NO_JIRA): Promise<Rig> {
  const dir = await tempDir(t);
  const root = path.join(dir, 'worklog');
  await mkdir(path.join(root, 'skills', 'worklog-update'), { recursive: true });
  await mkdir(path.join(root, 'bin'));
  await executable(path.join(root, 'bin', 'worklog'));
  await mkdir(path.join(root, 'web', 'dist', 'web', 'browser'), { recursive: true });
  await writeFile(path.join(root, 'web', 'dist', 'web', 'browser', 'index.html'), '');
  const skillsDir = path.join(dir, 'skills');
  await mkdir(skillsDir);
  await symlink(path.join(root, 'skills', 'worklog-update'), path.join(skillsDir, 'worklog-update'));
  const binDir = path.join(dir, 'bin');
  await mkdir(binDir);
  await symlink(path.join(root, 'bin', 'worklog'), path.join(binDir, 'worklog'));
  for (const app of ['Chrome.app', 'Warp.app', 'iTerm.app', 'Terminal.app', 'chrome-profile']) await mkdir(path.join(dir, app));
  const envFile = path.join(dir, 'env');
  await writeFile(envFile, 'WORKLOG_TERMINAL=warp\n');
  const profilePath = path.join(dir, 'profile.json');
  if (profile !== null) await writeFile(profilePath, JSON.stringify(profile));
  const dataDir = path.join(dir, 'data');
  await initDataRepo(dataDir);
  return {
    root,
    machine: {
      platform: 'darwin',
      nodeVersion: '24.3.0',
      execPath: '/usr/local/bin/node',
      rootDir: root,
      envFile,
      skillsDirs: { claude: skillsDir, codex: path.join(dir, 'agent-skills') },
      codexConfig: path.join(dir, 'codex-config.toml'),
      binDir,
      apps: { chrome: [path.join(dir, 'Chrome.app')], terminals: { warp: path.join(dir, 'Warp.app'), iterm: path.join(dir, 'iTerm.app'), terminal: path.join(dir, 'Terminal.app') } },
    },
    config: {
      dataDir,
      codeRoot: dir,
      chromeDir: path.join(dir, 'chrome-profile'),
      agents: { main: 'claude', bins: { claude: await executable(path.join(dir, 'claude')) } },
      editor: 'jetbrains',
      editorBin: await executable(path.join(dir, 'webstorm')),
      terminal: 'warp',
      port: 1,
      profilePath,
      profileSource: 'https://git.example.com/team/docs/-/blob/main/profile.json',
      jiraFiles: { p12Path: path.join(dir, 'jira.p12'), caPath: path.join(dir, 'jira-ca.crt'), keychainService: 'test-p12', tokenService: 'test-token' },
    },
    probes: {
      run: async () => ({ code: 0, stdout: 'git version 2.50.0\n', stderr: '' }),
      readPassword: async () => null,
      jiraRequest: async () => ({ status: 200, body: '{"name":"jdoe"}' }),
      health: async () => 'free',
    },
  };
}

function byId(checks: readonly Check[], id: CheckId): Check {
  const found = checks.find(item => item.id === id);
  assert.ok(found, id);
  return found;
}

function keychain(items: Record<string, string>) {
  return async (service: string): Promise<string | null> => (Object.hasOwn(items, service) ? items[service] : null);
}

test('doctor passes on a complete setup', async t => {
  const { machine, config, probes } = await rig(t);
  const checks = await runDoctor(machine, config, probes);
  assert.deepEqual(checks.filter(item => item.status === 'fail' || item.status === 'warn'), []);
  for (const id of ['p12', 'token', 'jira'] as const) assert.equal(byId(checks, id).status, 'skip');
  assert.equal(byId(checks, 'port').detail, '1 свободен');
});

test('doctor reports a broken env and still checks the machine', async t => {
  const { machine, probes } = await rig(t);
  const checks = await runDoctor(machine, 'Некорректное значение WORKLOG_TERMINAL: termnal (warp, iterm, terminal)', probes);
  assert.equal(byId(checks, 'env').status, 'fail');
  assert.match(byId(checks, 'env').detail, /WORKLOG_TERMINAL: termnal/);
  for (const id of ['macos', 'node', 'git'] as const) assert.equal(byId(checks, id).status, 'ok');
  assert.equal(byId(checks, 'data').status, 'skip');
  assert.equal(checks.length, 19);
});

test('doctor wants full paths to claude and the editor', async t => {
  const { machine, config, probes } = await rig(t);
  const checks = await runDoctor(machine, { ...config, agents: { main: 'claude', bins: { claude: 'claude' } }, editor: 'vscode', editorBin: '/nowhere/code' }, probes);
  assert.equal(byId(checks, 'agents').status, 'fail');
  assert.equal(byId(checks, 'agents').fix, 'worklog config set WORKLOG_CLAUDE_BIN "$(command -v claude)"');
  assert.equal(byId(checks, 'editor').fix, 'worklog config set WORKLOG_EDITOR_BIN "$(command -v code)"');
});

test('doctor tells a foreign skill from a missing one', async t => {
  const { machine, config, probes, root } = await rig(t);
  await mkdir(path.join(root, 'skills', 'worklog-tabs'));
  const missing = byId(await runDoctor(machine, config, probes), 'skills');
  assert.equal(missing.status, 'fail');
  assert.match(missing.detail, /не установлены: .*skills\/worklog-tabs/);
  assert.match(missing.fix ?? '', /npm run skills/);

  await mkdir(path.join(machine.skillsDirs.claude, 'worklog-tabs'));
  const foreign = byId(await runDoctor(machine, config, probes), 'skills');
  assert.match(foreign.detail, /не из этого клона: .*worklog-tabs/);
  assert.match(foreign.fix ?? '', /спроси коллегу/);
});

test('doctor warns when data lives in the code repo', async t => {
  const { machine, config, probes } = await rig(t);
  const code = path.join(path.dirname(config.dataDir), 'code');
  await mkdir(path.join(code, 'data'), { recursive: true });
  await writeFile(path.join(code, 'data', 'todos.json'), '[]');
  execFileSync('git', ['init', '--quiet', code]);
  execFileSync('git', ['-C', code, 'add', '-A']);
  execFileSync('git', ['-C', code, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', 'код']);
  const data = byId(await runDoctor(machine, { ...config, dataDir: path.join(code, 'data') }, probes), 'data');
  assert.equal(data.status, 'warn');
  assert.match(data.detail, /в git кода/);

  const missing = byId(await runDoctor(machine, { ...config, dataDir: path.join(code, 'nothing') }, probes), 'data');
  assert.equal(missing.status, 'fail');
  assert.equal(missing.fix, 'worklog data init');
});

test('doctor flags unknown env names', async t => {
  const { machine, config, probes } = await rig(t);
  await writeFile(machine.envFile, 'WORKLOG_TERMNAL=warp\n');
  const env = byId(await runDoctor(machine, config, probes), 'env');
  assert.equal(env.status, 'warn');
  assert.match(env.detail, /WORKLOG_TERMNAL/);
});

test('doctor reports the profile: missing, without a source, broken', async t => {
  const { machine, config, probes } = await rig(t, null);
  assert.equal(byId(await runDoctor(machine, config, probes), 'profile').status, 'warn');
  await writeFile(config.profilePath, JSON.stringify(NO_JIRA));
  assert.match(byId(await runDoctor(machine, { ...config, profileSource: undefined }, probes), 'profile').detail, /источник не записан/);
  await writeFile(config.profilePath, '{');
  assert.equal(byId(await runDoctor(machine, config, probes), 'profile').status, 'fail');
});

test('formatChecks marks each status and the fix', () => {
  const text = formatChecks([
    { id: 'node', status: 'ok', detail: '24.3.0' },
    { id: 'env', status: 'warn', detail: 'нет файла', fix: 'worklog config set' },
    { id: 'data', status: 'fail', detail: 'нет git', fix: 'worklog data init' },
    { id: 'jira', status: 'skip', detail: 'в профиле нет Jira', fix: 'не показывать' },
  ]);
  assert.equal(text, '✓ node: 24.3.0\n! env: нет файла\n    → worklog config set\n✗ data: нет git\n    → worklog data init\n– jira: в профиле нет Jira\nОшибок: 1');
  assert.equal(formatChecks([{ id: 'node', status: 'ok', detail: '24' }]).split('\n').at(-1), 'Всё в порядке');
});

test('doctor checks the certificate file, its rights and its password', async t => {
  const { machine, config, probes } = await rig(t, TEST_PROFILE);
  const p12 = () => runDoctor(machine, config, probes).then(checks => byId(checks, 'p12'));
  assert.match((await p12()).detail, /нет сертификата/);
  await writeFile(config.jiraFiles.p12Path, 'not a real certificate', { mode: 0o644 });
  await chmod(config.jiraFiles.p12Path, 0o644);
  assert.equal((await p12()).fix, `chmod 600 '${config.jiraFiles.p12Path}'`);
  await chmod(config.jiraFiles.p12Path, 0o600);
  assert.match((await p12()).detail, /нет пароля от сертификата/);
  probes.readPassword = keychain({ 'test-p12': 'pass' });
  const unreadable = await p12();
  assert.equal(unreadable.status, 'fail');
  assert.match(unreadable.detail, /не открыва/);

  await writeFile(config.profilePath, JSON.stringify({ ...TEST_PROFILE, jira: { ...TEST_PROFILE.jira, clientCert: false } }));
  assert.equal((await p12()).status, 'skip');
});

test('doctor runs the Jira check only after the certificate and the token', async t => {
  const { machine, config, probes } = await rig(t, { ...TEST_PROFILE, jira: { url: 'https://jira.example.com', clientCert: false, stages: {} } });
  let asked = 0;
  probes.jiraRequest = async () => {
    asked++;
    return { status: 200, body: '{"name":"jdoe"}' };
  };
  const noToken = await runDoctor(machine, config, probes);
  assert.equal(byId(noToken, 'token').status, 'fail');
  assert.equal(byId(noToken, 'jira').status, 'skip');
  assert.equal(asked, 0);

  probes.readPassword = keychain({ 'test-token': 'secret' });
  const jira = byId(await runDoctor(machine, config, probes), 'jira');
  assert.deepEqual(jira, { id: 'jira', status: 'ok', detail: 'отвечает, пользователь jdoe' });

  probes.jiraRequest = async () => {
    throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
  };
  assert.match(byId(await runDoctor(machine, config, probes), 'jira').fix ?? '', /VPN/);
});

test('doctor never prints secrets', async t => {
  const { machine, config, probes } = await rig(t, { ...TEST_PROFILE, jira: { url: 'https://jira.example.com', clientCert: false, stages: {} } });
  probes.readPassword = keychain({ 'test-token': 'SECRET-TOKEN-1', 'test-p12': 'SECRET-PASS-1' });
  const unauthorized: JiraRequest = async () => ({ status: 401, body: 'SECRET-TOKEN-1 rejected' });
  probes.jiraRequest = unauthorized;
  const withoutCert = await runDoctor(machine, config, probes);
  assert.equal(byId(withoutCert, 'jira').status, 'fail');

  await writeFile(config.profilePath, JSON.stringify(TEST_PROFILE));
  await writeFile(config.jiraFiles.p12Path, 'not a real certificate', { mode: 0o600 });
  const withCert = await runDoctor(machine, config, probes);
  for (const checks of [withoutCert, withCert]) {
    for (const text of [formatChecks(checks), JSON.stringify(checks)]) {
      assert.equal(text.includes('SECRET-TOKEN-1'), false);
      assert.equal(text.includes('SECRET-PASS-1'), false);
    }
  }
});

test('worklogHealth tells free, Worklog and a stranger apart', async t => {
  const serve = async (body: string): Promise<number> => {
    const server = http.createServer((_req, res) => res.end(body));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const address: AddressInfo | string | null = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    return address.port;
  };
  const worklog = await serve('{"ok":true,"clients":0}');
  const stranger = await serve('hello');
  const free = await new Promise<number>(resolve => {
    const probe = http.createServer().listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(address !== null && typeof address !== 'string' ? address.port : 0));
    });
  });
  assert.equal(await worklogHealth(worklog), 'worklog');
  assert.equal(await worklogHealth(stranger), 'other');
  assert.equal(await worklogHealth(free), 'free');
});

test('doctor checks the main agent and the second one', async t => {
  const { machine, config, probes } = await rig(t);
  const codex = await executable(path.join(path.dirname(config.dataDir), 'codex'));
  const both = { ...config, agents: { main: 'codex' as const, bins: { claude: config.agents.bins.claude, codex } } };
  await mkdir(machine.skillsDirs.codex, { recursive: true });
  await symlink(path.join(machine.rootDir, 'skills', 'worklog-update'), path.join(machine.skillsDirs.codex, 'worklog-update'));
  const checks = await runDoctor(machine, both, probes);
  assert.deepEqual(byId(checks, 'agents'), { id: 'agents', status: 'ok', detail: 'codex (основной), claude' });
  assert.equal(byId(checks, 'skills').status, 'ok');

  const broken = await runDoctor(machine, { ...both, agents: { main: 'claude', bins: { claude: config.agents.bins.claude, codex: '/nowhere/codex' } } }, probes);
  assert.equal(byId(broken, 'agents').fix, 'worklog config set WORKLOG_CODEX_BIN "$(command -v codex)"');
});

test('doctor wants a path for the chosen agent', async t => {
  const { machine, config, probes } = await rig(t);
  const agents = byId(await runDoctor(machine, { ...config, agents: { main: 'codex', bins: config.agents.bins } }, probes), 'agents');
  assert.equal(agents.detail, 'нет пути к codex');
});

test('doctor checks skills in each agent\'s folder', async t => {
  const { machine, config, probes } = await rig(t);
  const codex = await executable(path.join(path.dirname(config.dataDir), 'codex'));
  const skills = byId(await runDoctor(machine, { ...config, agents: { main: 'claude', bins: { ...config.agents.bins, codex } } }, probes), 'skills');
  assert.equal(skills.status, 'fail');
  assert.match(skills.detail, /agent-skills\/worklog-update/);
});

test('doctor warns when Codex cannot write the data', async t => {
  const { machine, config, probes } = await rig(t);
  assert.equal(byId(await runDoctor(machine, config, probes), 'codex-data').status, 'skip');
  const codex = await executable(path.join(path.dirname(config.dataDir), 'codex'));
  const withCodex = { ...config, agents: { main: 'claude' as const, bins: { ...config.agents.bins, codex } } };
  assert.equal(byId(await runDoctor(machine, withCodex, probes), 'codex-data').status, 'warn');
  await writeFile(machine.codexConfig, `model = "x"\n\n[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(config.dataDir)}]\n`);
  assert.equal(byId(await runDoctor(machine, withCodex, probes), 'codex-data').status, 'ok');
});

test('doctor refuses an agent path that dies with the shell', async t => {
  const { machine, config, probes } = await rig(t);
  const shellDir = path.join(path.dirname(config.dataDir), 'fnm_multishells', '123_456', 'bin');
  await mkdir(shellDir, { recursive: true });
  const codex = await executable(path.join(shellDir, 'codex'));
  const agents = byId(await runDoctor(machine, { ...config, agents: { main: 'codex', bins: { codex } } }, probes), 'agents');
  assert.equal(agents.status, 'fail');
  assert.equal(agents.fix, 'worklog config set WORKLOG_CODEX_BIN "$(realpath "$(command -v codex)")"');
});
