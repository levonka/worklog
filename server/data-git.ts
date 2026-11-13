import { execFile } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { LOCK_DIR_NAMES, TMP_MARKER, isErrorCode } from './fs-utils.ts';
import { quietGitEnv } from './git-env.ts';
import { DRAFT_FILE } from './store.ts';

const run = promisify(execFile);

/** own — data/ is the root of its own repository; shared — a code repository tracks its files; none — neither */
const DATA_REPO_STATES = ['own', 'none', 'shared'] as const;
export type DataRepoState = (typeof DATA_REPO_STATES)[number];

/** what the store writes besides the data: its locks, half-written files and the daily draft */
export const DATA_GITIGNORE = `${[...LOCK_DIR_NAMES.map(name => `${name}/`), `*${TMP_MARKER}*`, DRAFT_FILE].join('\n')}\n`;

// snapshots of data are no one's work, and the machine may have no git identity
const IDENTITY = ['-c', 'user.name=Worklog', '-c', 'user.email=worklog@localhost'];

async function git(dataDir: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', dataDir, ...args], { env: quietGitEnv() });
  return stdout;
}

export async function dataRepoState(dataDir: string): Promise<DataRepoState> {
  let top: string;
  try {
    top = (await git(dataDir, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return 'none';
  }
  if (top === (await realpath(dataDir))) return 'own';
  const tracked = await git(dataDir, ['ls-files', '--', '.']).catch(() => '');
  return tracked.trim() === '' ? 'none' : 'shared';
}

export async function initDataRepo(dataDir: string): Promise<'created' | 'exists'> {
  await mkdir(dataDir, { recursive: true });
  const state = await dataRepoState(dataDir);
  if (state === 'own') return 'exists';
  if (state === 'shared') throw new Error(`${dataDir} лежит в git кода: свой git для данных заводится при переезде, а не поверх`);
  await git(dataDir, ['init', '--quiet', '--initial-branch=main']);
  await writeFile(path.join(dataDir, '.gitignore'), DATA_GITIGNORE, { flag: 'wx' }).catch((error: unknown) => {
    if (!isErrorCode(error, 'EEXIST')) throw error;
  });
  await git(dataDir, ['add', '-A']);
  await git(dataDir, [...IDENTITY, 'commit', '--quiet', '-m', 'Данные Worklog']);
  return 'created';
}

/** the short hash of the new commit, or null when nothing changed */
export async function commitData(dataDir: string, message: string): Promise<string | null> {
  if ((await dataRepoState(dataDir)) !== 'own') throw new Error(`У ${dataDir} нет своего git: worklog data init`);
  await git(dataDir, ['add', '-A']);
  const changed = await git(dataDir, ['diff', '--cached', '--quiet']).then(
    () => false,
    () => true,
  );
  if (!changed) return null;
  await git(dataDir, [...IDENTITY, 'commit', '--quiet', '-m', message]);
  return (await git(dataDir, ['rev-parse', '--short', 'HEAD'])).trim();
}

/** a commit of what changed, at most once a day and only when the day has no commit yet; nothing without data's own git */
export async function snapshotData(dataDir: string, today: string): Promise<string | null> {
  if ((await dataRepoState(dataDir)) !== 'own') return null;
  const lastDay = (await git(dataDir, ['log', '-1', '--format=%cs'])).trim();
  if (lastDay === today) return null;
  return commitData(dataDir, `Снимок ${today}`);
}
