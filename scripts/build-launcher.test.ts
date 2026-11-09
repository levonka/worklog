import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SCRIPTS_DIR = path.resolve(import.meta.dirname);

test('build-launcher.sh keeps quotes and backslashes of the project path intact', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-launcher-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'проект "в кавычках" \\ с косой');
  const home = path.join(dir, 'home');
  await mkdir(path.join(home, 'Desktop'), { recursive: true });
  await cp(SCRIPTS_DIR, path.join(root, 'scripts'), { recursive: true });

  await run('zsh', [path.join(root, 'scripts', 'build-launcher.sh')], { env: { ...process.env, HOME: home } });

  const { stdout } = await run('osadecompile', [path.join(home, 'Desktop', 'Worklog.app', 'Contents', 'Resources', 'Scripts', 'main.scpt')]);
  const literal = (await realRoot(root)).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  assert.ok(stdout.includes(`"${literal}/scripts/start.sh"`), stdout);
});

async function realRoot(root: string): Promise<string> {
  // zsh's ${0:A} resolves /var to /private/var
  const { stdout } = await run('realpath', [root]);
  return stdout.trimEnd();
}
