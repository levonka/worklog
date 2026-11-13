import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UpdateRun } from '../shared/model.ts';
import { initDataRepo } from './data-git.ts';
import { gitIn } from './update-check.ts';
import type { UpdateDeps } from './update-run.ts';
import { runUpdate } from './update-run.ts';

const STARTED = '2026-11-13T12:00:00.000Z';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

interface Setup {
  clone: string;
  origin: string;
  dataDir: string;
  profilePath: string;
  calls: string[];
  runs: UpdateRun[];
  deps: UpdateDeps;
}

/** a clone one version behind its bare origin, data with its own git, the old build in web/dist and fakes for npm, the CLI and the server */
async function setup(t: TestContext, fakes: Partial<UpdateDeps> = {}): Promise<Setup> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-update-run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const origin = path.join(dir, 'origin.git');
  const publisher = path.join(dir, 'publisher');
  const clone = path.join(dir, 'clone');
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  execFileSync('git', ['clone', '--quiet', origin, publisher]);
  await writeFile(path.join(publisher, 'version.txt'), 'v1\n');
  await writeFile(path.join(publisher, 'notes.txt'), 'notes\n');
  await writeFile(path.join(publisher, '.gitignore'), 'web/dist/\nweb/dist-next/\nweb/dist-prev/\nlogs/\n');
  git(publisher, 'add', '-A');
  git(publisher, 'commit', '--quiet', '-m', 'v1');
  git(publisher, 'push', '--quiet', 'origin', 'HEAD:main');
  execFileSync('git', ['clone', '--quiet', origin, clone]);
  await writeFile(path.join(publisher, 'version.txt'), 'v2\n');
  git(publisher, 'commit', '--quiet', '-am', 'v2');
  git(publisher, 'push', '--quiet', 'origin', 'HEAD:main');

  await mkdir(path.join(clone, 'web', 'dist', 'web', 'browser'), { recursive: true });
  await writeFile(path.join(clone, 'web', 'dist', 'web', 'browser', 'index.html'), 'old');
  const dataDir = path.join(dir, 'data');
  await initDataRepo(dataDir);
  const profilePath = path.join(dir, 'profile.json');
  await writeFile(profilePath, 'old profile');

  const calls: string[] = [];
  const runs: UpdateRun[] = [];
  const deps: UpdateDeps = {
    rootDir: clone,
    dataDir,
    profilePath,
    git: gitIn(clone),
    dataGit: gitIn(dataDir),
    npm: async args => {
      calls.push(`npm ${args.join(' ')}`);
      if (args.includes('build')) {
        await mkdir(path.join(clone, 'web', 'dist-next', 'web', 'browser'), { recursive: true });
        await writeFile(path.join(clone, 'web', 'dist-next', 'web', 'browser', 'index.html'), 'new');
      }
    },
    cli: async args => {
      calls.push(`cli ${args.join(' ')}`);
      return { code: 0, output: '' };
    },
    stopServer: async () => void calls.push('stop'),
    startServer: async () => void calls.push('start'),
    healthy: async () => true,
    writeRun: async run => void runs.push(run),
    now: () => new Date('2026-11-13T12:01:00.000Z'),
    log: () => {},
    ...fakes,
  };
  return { clone, origin, dataDir, profilePath, calls, runs, deps };
}

function failingNpm(s: { calls: string[] }, failOn: string): UpdateDeps['npm'] {
  return async args => {
    s.calls.push(`npm ${args.join(' ')}`);
    if (args.join(' ').includes(failOn)) throw new Error(`npm ${failOn} упал`);
  };
}

async function builtIndex(clone: string): Promise<string> {
  return readFile(path.join(clone, 'web', 'dist', 'web', 'browser', 'index.html'), 'utf8');
}

test('a successful update pulls, installs, builds, swaps the build, restarts and records done', async t => {
  const s = await setup(t);

  const run = await runUpdate(s.deps, STARTED);

  assert.deepEqual(run, { phase: 'done', startedAt: STARTED, finishedAt: '2026-11-13T12:01:00.000Z' });
  assert.deepEqual(s.runs, [run]);
  assert.equal(await readFile(path.join(s.clone, 'version.txt'), 'utf8'), 'v2\n');
  assert.deepEqual(s.calls, [
    'npm ci',
    'npm ci --prefix web',
    'npm --prefix web run build -- --output-path dist-next/web',
    'npm run skills',
    'cli profile check',
    'stop',
    'start',
  ]);
  assert.equal(await builtIndex(s.clone), 'new');
  assert.equal(await exists(path.join(s.clone, 'web', 'dist-prev')), false);
  assert.equal(await exists(path.join(s.clone, 'web', 'dist-next')), false);
  assert.equal(git(s.dataDir, 'log', '-1', '--format=%s'), 'Данные Worklog');
});

test('each failing step before the restart rolls the code back and leaves the old server alone', async t => {
  const cases: [string, (s: Setup) => Partial<UpdateDeps>, string][] = [
    [
      'pull',
      s => {
        git(s.clone, 'remote', 'set-url', 'origin', `${s.origin}-gone`);
        return {};
      },
      'не удалось забрать новую версию с GitHub',
    ],
    ['npm ci', s => ({ npm: failingNpm(s, 'ci --prefix web') }), 'не удалось скачать пакеты npm'],
    ['build', s => ({ npm: failingNpm(s, 'build') }), 'не удалось собрать окно'],
    [
      'stop',
      s => ({
        stopServer: async () => {
          s.calls.push('stop');
          throw new Error('нет процесса');
        },
      }),
      'не удалось остановить прежний сервер',
    ],
  ];
  for (const [name, fake, error] of cases) {
    const s = await setup(t);
    const before = git(s.clone, 'rev-parse', 'HEAD');
    Object.assign(s.deps, fake(s));

    const run = await runUpdate(s.deps, STARTED);

    assert.equal(run.phase, 'failed', name);
    assert.equal(run.error, error, name);
    assert.equal(git(s.clone, 'rev-parse', 'HEAD'), before, name);
    assert.equal(await readFile(path.join(s.clone, 'version.txt'), 'utf8'), 'v1\n', name);
    assert.equal(s.calls.includes('start'), false, name);
    assert.equal(await builtIndex(s.clone), 'old', name);
    assert.equal(await exists(path.join(s.clone, 'web', 'dist-next')), false, name);
    assert.deepEqual(s.runs, [run], name);
  }
});

test('a missing data snapshot stops before anything changes', async t => {
  const s = await setup(t);
  await rm(path.join(s.dataDir, '.git'), { recursive: true, force: true });
  const before = git(s.clone, 'rev-parse', 'HEAD');

  const run = await runUpdate(s.deps, STARTED);

  assert.equal(run.error, 'нет снимка данных');
  assert.equal(git(s.clone, 'rev-parse', 'HEAD'), before);
  assert.deepEqual(s.calls, []);
});

test('a profile the new version cannot read is updated, and restored when the update fails', async t => {
  const s = await setup(t);
  const cli = (updateCode: number): UpdateDeps['cli'] => async args => {
    s.calls.push(`cli ${args.join(' ')}`);
    if (args[1] === 'check') return { code: 3, output: 'обнови профиль' };
    // a failed fetch may leave the file half-written
    await writeFile(s.profilePath, updateCode === 0 ? 'new profile' : 'half-written');
    return { code: updateCode, output: updateCode === 0 ? '' : 'нет доступа к GitLab' };
  };
  s.deps.cli = cli(1);

  const refused = await runUpdate(s.deps, STARTED);

  assert.equal(refused.error, 'нужен новый профиль компании. Обновите через агента: обнови worklog');
  assert.equal(await readFile(s.profilePath, 'utf8'), 'old profile');
  assert.equal(await readFile(path.join(s.clone, 'version.txt'), 'utf8'), 'v1\n');

  const later = await setup(t, { healthy: async () => false });
  later.deps.cli = async args => {
    later.calls.push(`cli ${args.join(' ')}`);
    if (args[1] === 'check') return { code: 3, output: '' };
    await writeFile(later.profilePath, 'new profile');
    return { code: 0, output: '' };
  };

  const unhealthy = await runUpdate(later.deps, STARTED);

  assert.equal(unhealthy.error, 'новая версия не запустилась');
  assert.equal(await readFile(later.profilePath, 'utf8'), 'old profile');
});

test('a new version that does not start is rolled back with its data', async t => {
  let starts = 0;
  const s = await setup(t, { healthy: async () => false });
  s.deps.startServer = async () => {
    starts++;
    s.calls.push('start');
    // the new version converts data on start
    if (starts === 1) await writeFile(path.join(s.dataDir, 'todos.json'), '[{"converted":true}]');
  };
  const before = git(s.clone, 'rev-parse', 'HEAD');

  const run = await runUpdate(s.deps, STARTED);

  assert.deepEqual(run, { phase: 'failed', startedAt: STARTED, finishedAt: '2026-11-13T12:01:00.000Z', error: 'новая версия не запустилась', dataRestored: true });
  assert.equal(starts, 2);
  assert.deepEqual(s.calls.slice(-4), ['stop', 'start', 'stop', 'start']);
  assert.equal(git(s.clone, 'rev-parse', 'HEAD'), before);
  assert.equal(await builtIndex(s.clone), 'old');
  assert.equal(await exists(path.join(s.dataDir, 'todos.json')), false);
  assert.equal(git(s.dataDir, 'status', '--porcelain'), '');
});

test('data written by the user during the update is in the snapshot the rollback returns to', async t => {
  const s = await setup(t, { healthy: async () => false });
  s.deps.npm = async args => {
    s.calls.push(`npm ${args.join(' ')}`);
    if (args[0] === 'run' && args[1] === 'skills') await writeFile(path.join(s.dataDir, 'notes.json'), 'written meanwhile');
    if (args.includes('build')) {
      await mkdir(path.join(s.clone, 'web', 'dist-next', 'web', 'browser'), { recursive: true });
      await writeFile(path.join(s.clone, 'web', 'dist-next', 'web', 'browser', 'index.html'), 'new');
    }
  };

  const run = await runUpdate(s.deps, STARTED);

  assert.equal(run.dataRestored, undefined);
  assert.equal(await readFile(path.join(s.dataDir, 'notes.json'), 'utf8'), 'written meanwhile');
  assert.equal(git(s.dataDir, 'log', '-1', '--format=%s'), 'Перед перезапуском Worklog');
});

test('a rollback whose old server does not start still records the failure', async t => {
  let starts = 0;
  const s = await setup(t, { healthy: async () => false });
  s.deps.startServer = async () => {
    starts++;
    if (starts === 2) throw new Error('порт занят');
  };

  const run = await runUpdate(s.deps, STARTED);

  assert.equal(run.error, 'новая версия не запустилась');
  assert.deepEqual(s.runs, [run]);
});

test('a failing npm run skills does not stop the update', async t => {
  const s = await setup(t);
  s.deps.npm = async args => {
    s.calls.push(`npm ${args.join(' ')}`);
    if (args[1] === 'skills') throw new Error('имя занято');
    if (args.includes('build')) {
      await mkdir(path.join(s.clone, 'web', 'dist-next', 'web', 'browser'), { recursive: true });
      await writeFile(path.join(s.clone, 'web', 'dist-next', 'web', 'browser', 'index.html'), 'new');
    }
  };

  const run = await runUpdate(s.deps, STARTED);

  assert.equal(run.phase, 'done');
  assert.equal(await builtIndex(s.clone), 'new');
});

test('own edits or commits made after the last check stop the update before anything changes', async t => {
  const edited = await setup(t);
  await writeFile(path.join(edited.clone, 'notes.txt'), 'mine\n');

  const run = await runUpdate(edited.deps, STARTED);

  assert.equal(run.error, 'В папке Worklog есть свои правки — обновите её через git');
  assert.deepEqual(edited.calls, []);
  assert.equal(await readFile(path.join(edited.clone, 'notes.txt'), 'utf8'), 'mine\n');
  assert.equal(await readFile(path.join(edited.clone, 'version.txt'), 'utf8'), 'v1\n');

  const committed = await setup(t);
  await writeFile(path.join(committed.clone, 'notes.txt'), 'mine\n');
  git(committed.clone, 'commit', '--quiet', '-am', 'mine');
  assert.equal((await runUpdate(committed.deps, STARTED)).error, 'В папке Worklog есть свои правки — обновите её через git');
  assert.deepEqual(committed.calls, []);
});

test('a rollback keeps edits made while the update ran', async t => {
  const s = await setup(t);
  s.deps.npm = async args => {
    s.calls.push(`npm ${args.join(' ')}`);
    if (args.join(' ') === 'ci') await writeFile(path.join(s.clone, 'notes.txt'), 'typed meanwhile\n');
    if (args.join(' ') === 'ci --prefix web') throw new Error('npm упал');
  };

  const run = await runUpdate(s.deps, STARTED);

  assert.equal(run.error, 'не удалось скачать пакеты npm');
  assert.equal(await readFile(path.join(s.clone, 'notes.txt'), 'utf8'), 'typed meanwhile\n');
  assert.equal(await readFile(path.join(s.clone, 'version.txt'), 'utf8'), 'v1\n');
});

test('a build that writes nothing fails before the server stops', async t => {
  const s = await setup(t);
  s.deps.npm = async args => void s.calls.push(`npm ${args.join(' ')}`);

  const run = await runUpdate(s.deps, STARTED);

  assert.equal(run.error, 'не удалось собрать окно');
  assert.equal(s.calls.includes('stop'), false);
  assert.equal(await builtIndex(s.clone), 'old');
  assert.equal(await readFile(path.join(s.clone, 'version.txt'), 'utf8'), 'v1\n');
});

test('data written as the old server stops is in the snapshot a rollback returns to', async t => {
  const s = await setup(t, { healthy: async () => false });
  s.deps.stopServer = async () => {
    s.calls.push('stop');
    if (!s.calls.includes('start')) await writeFile(path.join(s.dataDir, 'todos.json'), 'last write');
  };

  const run = await runUpdate(s.deps, STARTED);

  assert.equal(run.error, 'новая версия не запустилась');
  assert.equal(run.dataRestored, undefined);
  assert.equal(await readFile(path.join(s.dataDir, 'todos.json'), 'utf8'), 'last write');
});

test('a snapshot that fails after the stop starts the old server again', async t => {
  const s = await setup(t);
  s.deps.stopServer = async () => {
    s.calls.push('stop');
    await rm(path.join(s.dataDir, '.git'), { recursive: true, force: true });
  };
  const before = git(s.clone, 'rev-parse', 'HEAD');

  const run = await runUpdate(s.deps, STARTED);

  assert.equal(run.error, 'нет снимка данных');
  assert.deepEqual(s.calls.slice(-2), ['stop', 'start']);
  assert.equal(git(s.clone, 'rev-parse', 'HEAD'), before);
  assert.equal(await builtIndex(s.clone), 'old');
});
