import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { UpdateCheck, UpdateCheckResult, UpdateFacts } from '../shared/model.ts';
import { updateCheckOf } from '../shared/model.ts';
import { quietGitEnv } from './git-env.ts';

const run = promisify(execFile);
// a fetch that hangs on a dead network must not keep the check, or the update, waiting forever
const GIT_TIMEOUT_MS = 120_000;

export type GitRun = (args: string[]) => Promise<string>;

/** git in that folder, asking nothing: no password prompt, and ssh in batch mode unless the user set up their own ssh command */
export function gitIn(dir: string): GitRun {
  let env: Promise<NodeJS.ProcessEnv> | undefined;
  return async args => {
    env ??= gitBatchEnv(dir);
    const { stdout } = await run('git', ['-C', dir, ...args], { env: await env, timeout: GIT_TIMEOUT_MS });
    return stdout;
  };
}

/** the environment for git that asks nothing; also for `profile update`, which fetches the profile over ssh */
export async function gitBatchEnv(dir: string): Promise<NodeJS.ProcessEnv> {
  const env = quietGitEnv();
  if (env.GIT_SSH_COMMAND !== undefined) return env;
  const own = await run('git', ['-C', dir, 'config', '--get', 'core.sshCommand'], { env }).then(
    ({ stdout }) => stdout.trim(),
    () => '',
  );
  return own === '' ? { ...env, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' } : env;
}

/**
 * The clone against its tracked branch after fetching it; null without a branch to follow or its remote.
 * A failed fetch throws: the check the user asks for tells «could not ask» from «nothing new».
 */
export async function updateFacts(git: GitRun): Promise<UpdateFacts | null> {
  const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']).then(
    out => out.trim(),
    () => '',
  );
  if (branch === '') return null;
  const remote = await git(['config', '--get', `branch.${branch}.remote`]).then(
    out => out.trim(),
    () => '',
  );
  const merge = await git(['config', '--get', `branch.${branch}.merge`]).then(
    out => out.trim(),
    () => '',
  );
  if (remote === '' || merge === '') return null;
  const known = await git(['remote', 'get-url', remote]).then(
    () => true,
    () => false,
  );
  if (!known) return null;
  await git(['fetch', '--quiet', remote, merge]);
  const [counts, status] = await Promise.all([git(['rev-list', '--left-right', '--count', 'HEAD...@{u}']), git(['status', '--porcelain'])]);
  const [ahead = 0, behind = 0] = counts.trim().split(/\s+/).map(Number);
  return { ahead, behind, dirty: status.trim() !== '' };
}

/** the short hash of the code the server runs; null outside git */
export function currentVersion(git: GitRun): Promise<string | null> {
  return git(['rev-parse', '--short', 'HEAD']).then(
    out => out.trim() || null,
    () => null,
  );
}

export interface UpdateChecker {
  check(): UpdateCheck;
  /** asks now; checks running at the same time share one */
  refresh(): Promise<UpdateCheckResult>;
  start(): void;
  close(): void;
}

export function createUpdateChecker(opts: { facts: () => Promise<UpdateFacts | null>; intervalMs: number; onChange: () => void }): UpdateChecker {
  let current: UpdateCheck = 'none';
  let running: Promise<UpdateCheckResult> | null = null;
  let timer: NodeJS.Timeout | undefined;

  const ask = async (): Promise<UpdateCheckResult> => {
    let result: UpdateCheckResult;
    try {
      result = updateCheckOf(await opts.facts());
    } catch (error) {
      console.error('Проверка новой версии:', error instanceof Error ? error.message : error);
      result = 'unreachable';
    }
    const next = result === 'unreachable' ? 'none' : result;
    if (next !== current) {
      current = next;
      opts.onChange();
    }
    return result;
  };

  const refresh = (): Promise<UpdateCheckResult> => {
    running ??= ask().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    check: () => current,
    refresh,
    start() {
      void refresh();
      clearInterval(timer);
      timer = setInterval(() => void refresh(), opts.intervalMs);
      timer.unref();
    },
    close() {
      clearInterval(timer);
    },
  };
}
