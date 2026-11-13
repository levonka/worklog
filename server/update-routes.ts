import { readFile, rm } from 'node:fs/promises';
import type { UpdateCheckResult, UpdateRun, UpdateStatus } from '../shared/model.ts';
import { parseUpdateRun } from '../shared/model.ts';
import { HttpError } from './http.ts';
import type { Route } from './http.ts';
import { isErrorCode, writeJsonAtomic } from './fs-utils.ts';
import type { UpdateChecker } from './update-check.ts';

const OK = 200;
const ACCEPTED = 202;
const NO_CONTENT = 204;
const CONFLICT = 409;
const FAILED = 500;
const UNAVAILABLE = 503;
const OFF = 'Обновление по кнопке выключено';

/** the self-update; none (tests, the demo, WORKLOG_UPDATE_CHECK=off) answers «nothing new» and refuses to update */
export interface UpdateOptions {
  checker: UpdateChecker;
  /** the code this server runs */
  version: string | null;
  /** logs/update.json: the last run, shared with server/update-main.ts */
  runFile: string;
  /** starts server/update-main.ts, detached, which writes its own pid into the run; throws when it could not start */
  launch: (startedAt: string) => void;
  /** whether that process still lives */
  alive?: (pid: number) => boolean;
  now?: () => Date;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrorCode(error, 'EPERM');
  }
}

export async function readUpdateRun(update: UpdateOptions | undefined): Promise<UpdateRun | null> {
  if (update === undefined) return null;
  // a missing or broken file is no run: the window can still update and clear it
  const raw = await readFile(update.runFile, 'utf8')
    .then((text): unknown => JSON.parse(text))
    .catch(() => null);
  return parseUpdateRun(raw, (update.now ?? (() => new Date()))(), update.alive ?? processAlive);
}

export async function updateRunning(update: UpdateOptions | undefined): Promise<boolean> {
  return (await readUpdateRun(update))?.phase === 'running';
}

async function status(update: UpdateOptions | undefined): Promise<UpdateStatus> {
  if (update === undefined) return { check: 'none', version: null, run: null };
  return { check: update.checker.check(), version: update.version, run: await readUpdateRun(update) };
}

/** all outside the undo history: an update is no change of the user's data */
export function createUpdateRoutes(update: UpdateOptions | undefined, summaryRunning: () => Promise<boolean>): Route[] {
  // a second click arriving while the first still reads the run file
  let starting = false;
  return [
    { method: 'GET', pattern: /^\/api\/update$/, handler: async () => ({ status: OK, body: await status(update) }) },
    {
      method: 'POST',
      pattern: /^\/api\/update\/check$/,
      handler: async () => {
        if (update === undefined) throw new HttpError(UNAVAILABLE, OFF);
        // git in the clone while the update pulls and resets it could collide on its lock
        const result: UpdateCheckResult = (await updateRunning(update)) ? update.checker.check() : await update.checker.refresh();
        return { status: OK, body: { result, status: await status(update) } };
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/update$/,
      handler: async () => {
        if (update === undefined) throw new HttpError(UNAVAILABLE, OFF);
        if (starting) throw new HttpError(CONFLICT, 'Обновление уже идёт');
        starting = true;
        try {
          if (await updateRunning(update)) throw new HttpError(CONFLICT, 'Обновление уже идёт');
          // the clone as it is now, not as it was at the last check hours ago
          const check = await update.checker.refresh();
          if (check === 'unreachable') throw new HttpError(CONFLICT, 'Нет связи с GitHub — попробуйте позже');
          if (check === 'none') throw new HttpError(CONFLICT, 'Новой версии нет');
          if (check === 'local-changes') throw new HttpError(CONFLICT, 'В папке Worklog есть свои правки — обновите её через git');
          if (await summaryRunning()) throw new HttpError(CONFLICT, 'Идёт сборка дейлика из сессий — обновите после неё');
          // written before the launch: the update process writes after it, its pid first and its result last
          const run: UpdateRun = { phase: 'running', startedAt: (update.now ?? (() => new Date()))().toISOString() };
          await writeJsonAtomic(update.runFile, run);
          try {
            update.launch(run.startedAt);
          } catch {
            await rm(update.runFile, { force: true });
            throw new HttpError(FAILED, 'Не удалось запустить обновление');
          }
          return { status: ACCEPTED, body: { run } };
        } finally {
          starting = false;
        }
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/update\/run$/,
      handler: async () => {
        if (update !== undefined && !(await updateRunning(update))) await rm(update.runFile, { force: true });
        return { status: NO_CONTENT };
      },
    },
  ];
}
