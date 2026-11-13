import { access, copyFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { UpdateRun } from '../shared/model.ts';
import { UPDATE_HEALTH_MS, updateFailureText } from '../shared/model.ts';
import { commitData } from './data-git.ts';
import { errorMessage } from './fs-utils.ts';
import type { GitRun } from './update-check.ts';

/** everything an update touches outside plain files, so tests can stand in for git remotes, npm and the server */
export interface UpdateDeps {
  rootDir: string;
  dataDir: string;
  profilePath: string;
  /** git in the clone */
  git: GitRun;
  /** git in data/, its own repository */
  dataGit: GitRun;
  /** npm in the clone */
  npm(args: string[]): Promise<void>;
  /** the clone's CLI as it is on disk, that is the new version once pulled */
  cli(args: string[]): Promise<{ code: number; output: string }>;
  stopServer(): Promise<void>;
  startServer(): Promise<void>;
  healthy(timeoutMs: number): Promise<boolean>;
  writeRun(run: UpdateRun): Promise<void>;
  now(): Date;
  log(message: string): void;
}

const PROFILE_OLD = 3;
const NEEDS_PROFILE = 'нужен новый профиль компании. Обновите через агента: обнови worklog';
const OWN_WORK = 'В папке Worklog есть свои правки — обновите её через git';

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

class StepFailed extends Error {}

/** «Update Worklog» of INSTALL.md without the agent; whatever fails, the previous version is left working */
export async function runUpdate(deps: UpdateDeps, startedAt: string): Promise<UpdateRun> {
  const web = path.join(deps.rootDir, 'web');
  const dist = path.join(web, 'dist');
  const next = path.join(web, 'dist-next');
  const prev = path.join(web, 'dist-prev');
  const profileCopy = path.join(deps.rootDir, 'logs', 'profile-before-update.json');
  let profileSaved = false;

  const finish = async (run: UpdateRun): Promise<UpdateRun> => {
    // logs/update.log keeps the outcome too: the run file is replaced by the next update
    deps.log(run.phase === 'done' ? 'Обновление прошло' : updateFailureText(run));
    await deps.writeRun(run).catch(error => deps.log(`Итог обновления не записан: ${errorMessage(error)}`));
    return run;
  };
  const failed = (error: string, dataRestored = false): UpdateRun => ({
    phase: 'failed',
    startedAt,
    finishedAt: deps.now().toISOString(),
    error,
    ...(dataRestored ? { dataRestored: true } : {}),
  });
  const step = async (reason: string, action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      deps.log(`${reason}: ${errorMessage(error)}`);
      throw new StepFailed(reason);
    }
  };
  const quietly = (what: string) => (error: unknown) => deps.log(`${what}: ${errorMessage(error)}`);
  const restoreProfile = async (): Promise<void> => {
    if (profileSaved) await copyFile(profileCopy, deps.profilePath).catch(quietly('Профиль не возвращён'));
  };

  let before: string;
  try {
    // the check behind the button may be hours old: the clone's own work is never pulled over or reset
    await step(OWN_WORK, async () => {
      const [status, ahead] = await Promise.all([deps.git(['status', '--porcelain']), deps.git(['rev-list', '--count', '@{u}..HEAD'])]);
      if (status.trim() !== '' || ahead.trim() !== '0') throw new Error('правки или свои коммиты');
    });
    await step('нет снимка данных', () => commitData(deps.dataDir, 'Перед обновлением Worklog'));
    before = (await deps.git(['rev-parse', 'HEAD'])).trim();
  } catch (error) {
    return finish(failed(error instanceof StepFailed ? error.message : 'не удалось прочитать версию Worklog'));
  }
  // --keep, not --hard: an edit made while the update ran stays
  const resetCode = (): Promise<void> => deps.git(['reset', '--keep', '--quiet', before]).then(() => undefined, quietly('Код не возвращён'));
  let stopped = false;

  try {
    await step('не удалось забрать новую версию с GitHub', () => deps.git(['pull', '--ff-only', '--quiet']));
    await step('не удалось скачать пакеты npm', async () => {
      await deps.npm(['ci']);
      await deps.npm(['ci', '--prefix', 'web']);
    });
    await step('не удалось собрать окно', async () => {
      await rm(next, { recursive: true, force: true });
      await deps.npm(['--prefix', 'web', 'run', 'build', '--', '--output-path', 'dist-next/web']);
      // a build that exits 0 yet puts nothing where the server looks would leave an empty window
      if (!(await exists(path.join(next, 'web', 'browser', 'index.html')))) throw new Error('сборка не положила index.html');
    });
    // the links were made at install; a name taken by something else is no reason to stay on the old version
    await deps.npm(['run', 'skills']).catch(quietly('Скиллы не переустановлены'));
    if ((await deps.cli(['profile', 'check'])).code === PROFILE_OLD) {
      await step(NEEDS_PROFILE, async () => {
        await mkdir(path.dirname(profileCopy), { recursive: true });
        await copyFile(deps.profilePath, profileCopy);
        profileSaved = true;
        const updated = await deps.cli(['profile', 'update']);
        if (updated.code !== 0) throw new Error(updated.output);
      });
    }
    await step('не удалось остановить прежний сервер', () => deps.stopServer());
    stopped = true;
    // after the stop: nothing writes data any more, so a rollback loses nothing
    await step('нет снимка данных', () => commitData(deps.dataDir, 'Перед перезапуском Worklog'));
  } catch (error) {
    await resetCode();
    await rm(next, { recursive: true, force: true }).catch(quietly('Новая сборка не удалена'));
    await restoreProfile();
    const run = await finish(failed(error instanceof StepFailed ? error.message : errorMessage(error)));
    if (stopped) await deps.startServer().catch(quietly('Прежняя версия не стартовала'));
    return run;
  }

  let started = false;
  try {
    await rm(prev, { recursive: true, force: true });
    if (await exists(dist)) await rename(dist, prev);
    await rename(next, dist);
    await deps.startServer();
    started = true;
  } catch (error) {
    quietly('Новая версия не стартовала')(error);
  }
  if (started && (await deps.healthy(UPDATE_HEALTH_MS))) {
    await rm(prev, { recursive: true, force: true }).catch(quietly('Прежняя сборка не удалена'));
    await rm(profileCopy, { force: true }).catch(quietly('Копия профиля не удалена'));
    return finish({ phase: 'done', startedAt, finishedAt: deps.now().toISOString() });
  }

  await deps.stopServer().catch(quietly('Новая версия не остановлена'));
  await resetCode();
  // only with the previous build at hand: the build in place may be the only one
  if (await exists(prev)) {
    await rm(dist, { recursive: true, force: true }).catch(quietly('Новая сборка не удалена'));
    await rename(prev, dist).catch(quietly('Прежняя сборка не возвращена'));
  }
  await rm(next, { recursive: true, force: true }).catch(quietly('Новая сборка не удалена'));
  await restoreProfile();
  const dataRestored = await restoreData(deps.dataGit).catch(error => {
    quietly('Данные не возвращены')(error);
    return false;
  });
  // recorded before the old server starts: it reads the file, and it may not start at all
  const run = await finish(failed('новая версия не запустилась', dataRestored));
  await deps.startServer().catch(quietly('Прежняя версия не стартовала'));
  return run;
}

/** puts data back to the snapshot taken just before the restart, when the new version wrote anything since */
async function restoreData(dataGit: GitRun): Promise<boolean> {
  if ((await dataGit(['status', '--porcelain'])).trim() === '') return false;
  await dataGit(['reset', '--hard', '--quiet', 'HEAD']);
  await dataGit(['clean', '-fd', '--quiet']);
  return true;
}
