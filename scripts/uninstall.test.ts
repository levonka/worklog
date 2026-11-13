import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { access, cp, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SCRIPTS_DIR = path.resolve(import.meta.dirname);

interface Setup {
  /** the clone as zsh's ${0:A} sees it, /private/var and all */
  root: string;
  home: string;
  port: number;
  uninstall: () => Promise<{ stdout: string; stderr: string }>;
  buildLauncher: (root: string) => Promise<unknown>;
}

async function clone(dir: string, name: string): Promise<string> {
  const root = path.join(dir, name);
  await cp(SCRIPTS_DIR, path.join(root, 'scripts'), { recursive: true });
  await mkdir(path.join(root, 'skills', 'worklog-update'), { recursive: true });
  await mkdir(path.join(root, 'bin'), { recursive: true });
  await writeFile(path.join(root, 'bin', 'worklog'), '');
  return realpath(root);
}

async function setup(t: TestContext): Promise<Setup> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'worklog-uninstall-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = await clone(dir, 'worklog');
  const home = path.join(dir, 'home');
  for (const sub of ['Desktop', '.claude/skills', '.agents/skills', '.local/bin', '.warp/tab_configs']) await mkdir(path.join(home, sub), { recursive: true });
  const port = await freePort();
  const env = { ...process.env, HOME: home, WORKLOG_ENV_FILE: '/nonexistent', WORKLOG_PORT: String(port), CLAUDE_SKILLS_DIR: '', CODEX_SKILLS_DIR: '', WORKLOG_BIN_DIR: '' };
  return {
    root,
    home,
    port,
    uninstall: () => run('zsh', [path.join(root, 'scripts', 'uninstall.sh')], { env }),
    buildLauncher: other => run('zsh', [path.join(other, 'scripts', 'build-launcher.sh')], { env }),
  };
}

async function exists(file: string): Promise<boolean> {
  return lstat(file).then(
    () => true,
    () => false,
  );
}

test('uninstall.sh removes the links into the clone and leaves the rest alone', async t => {
  const { root, home, uninstall } = await setup(t);
  const elsewhere = await mkdtemp(path.join(tmpdir(), 'worklog-foreign-'));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  await symlink(path.join(root, 'skills', 'worklog-update'), path.join(home, '.claude/skills/worklog-update'));
  await symlink(path.join(root, 'skills', 'worklog-update'), path.join(home, '.agents/skills/worklog-update'));
  await symlink(elsewhere, path.join(home, '.claude/skills/worklog-notes'));
  await mkdir(path.join(home, '.claude/skills/own-skill'));
  await symlink(path.join(root, 'bin', 'worklog'), path.join(home, '.local/bin/worklog'));
  await writeFile(path.join(home, '.warp/tab_configs/worklog-run-abc.toml'), '');
  await writeFile(path.join(home, '.warp/tab_configs/my-tab.toml'), '');

  const { stdout } = await uninstall();

  assert.deepEqual((await readdir(path.join(home, '.claude/skills'))).sort(), ['own-skill', 'worklog-notes']);
  assert.equal(await readlink(path.join(home, '.claude/skills/worklog-notes')), elsewhere);
  assert.deepEqual(await readdir(path.join(home, '.agents/skills')), []);
  assert.equal(await exists(path.join(home, '.local/bin/worklog')), false);
  assert.deepEqual(await readdir(path.join(home, '.warp/tab_configs')), ['my-tab.toml']);
  assert.match(stdout, /Убрано: .*worklog-update/);
});

test('uninstall.sh removes its own launcher, not one of another clone or a foreign app', async t => {
  const { root, home, uninstall, buildLauncher } = await setup(t);
  const app = path.join(home, 'Desktop', 'Worklog.app');

  await buildLauncher(root);
  await uninstall();
  assert.equal(await exists(app), false);

  await buildLauncher(await clone(path.dirname(root), 'another'));
  await uninstall();
  await access(app);

  await rm(app, { recursive: true });
  await mkdir(path.join(app, 'Contents'), { recursive: true });
  await writeFile(path.join(app, 'Contents', 'Info.plist'), 'чужое приложение');
  await uninstall();
  await access(path.join(app, 'Contents', 'Info.plist'));
});

test('uninstall.sh stops the server of the clone', async t => {
  const { root, port, uninstall } = await setup(t);
  await mkdir(path.join(root, 'server'));
  await writeFile(path.join(root, 'server', 'main.ts'), LISTENER);
  const server = await listen(t, [path.join(root, 'server', 'main.ts')], port);

  const { stdout } = await uninstall();

  assert.match(stdout, /Сервер Worklog остановлен/);
  await exited(server);
});

test('uninstall.sh leaves another program on the port running', async t => {
  const { port, uninstall } = await setup(t);
  const other = await listen(t, ['--input-type=module', '-e', LISTENER], port);

  await uninstall();

  assert.equal(other.exitCode, null);
  assert.equal(other.signalCode, null);
});

const LISTENER = `import http from 'node:http'; http.createServer().listen(Number(process.env.PORT), '127.0.0.1', () => console.log('ready'));`;

async function listen(t: TestContext, args: string[], port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, args, { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => {
    child.kill();
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once('data', () => resolve());
    child.once('exit', code => reject(new Error(`слушатель вышел с кодом ${code}`)));
  });
  return child;
}

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => child.once('exit', resolve));
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise(resolve => server.close(resolve));
  if (address === null || typeof address === 'string') throw new Error('нет порта');
  return address.port;
}
