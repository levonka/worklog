import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SCRIPTS_DIR = path.resolve(import.meta.dirname);

interface Setup {
  root: string;
  app: string;
  build: () => Promise<{ stdout: string; stderr: string }>;
}

async function setup(t: { after: (fn: () => Promise<void>) => void }, rootName = 'worklog'): Promise<Setup> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-launcher-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, rootName);
  const home = path.join(dir, 'home');
  await mkdir(path.join(home, 'Desktop'), { recursive: true });
  await cp(SCRIPTS_DIR, path.join(root, 'scripts'), { recursive: true });
  const build = () => run('zsh', [path.join(root, 'scripts', 'build-launcher.sh')], { env: { ...process.env, HOME: home } });
  return { root, app: path.join(home, 'Desktop', 'Worklog.app'), build };
}

function mainScript(app: string): string {
  return path.join(app, 'Contents', 'Resources', 'Scripts', 'main.scpt');
}

test('build-launcher.sh keeps quotes and backslashes of the project path intact', async t => {
  const { root, app, build } = await setup(t, 'проект "в кавычках" \\ с косой');

  await build();

  const { stdout } = await run('osadecompile', [mainScript(app)]);
  const literal = (await realRoot(root)).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  assert.ok(stdout.includes(`"${literal}/scripts/start.sh"`), stdout);
});

test('build-launcher.sh replaces a launcher it built before', async t => {
  const { app, build } = await setup(t);
  await build();

  await build();

  await access(mainScript(app));
});

test('build-launcher.sh leaves a foreign Worklog.app on the Desktop alone', async t => {
  const { app, build } = await setup(t);
  const foreign = path.join(app, 'Contents', 'Info.plist');
  await mkdir(path.dirname(foreign), { recursive: true });
  await writeFile(foreign, 'чужое приложение');

  await assert.rejects(build(), (error: unknown) => error instanceof Error && 'stderr' in error && String(error.stderr).includes('не ярлык Worklog'));

  await access(foreign);
});

async function realRoot(root: string): Promise<string> {
  // zsh's ${0:A} resolves /var to /private/var
  const { stdout } = await run('realpath', [root]);
  return stdout.trimEnd();
}
