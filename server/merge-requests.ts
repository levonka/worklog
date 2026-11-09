import { execFile } from 'node:child_process';
import { quietGitEnv } from './git-env.ts';
import { promisify } from 'node:util';
import { directionBranch } from '../shared/model.ts';
import type { Store } from './store.ts';

const run = promisify(execFile);
const MR_HEADS = 'refs/merge-requests/*/head';
const MR_HEAD = /^refs\/merge-requests\/(\d+)\/head$/;
const BRANCH_HEAD = 'refs/heads/';
const TIMEOUT_MS = 30_000;

/** `git ls-remote origin <patterns>` in the code root: `<sha>\t<ref>` lines */
export type LsRemote = (codeRoot: string, patterns: readonly string[]) => Promise<string>;

export const gitLsRemote: LsRemote = async (codeRoot, patterns) => {
  return (await run('git', ['-C', codeRoot, 'ls-remote', 'origin', ...patterns], { env: quietGitEnv(), timeout: TIMEOUT_MS })).stdout;
};

/** branch → the newest MR whose head is the branch's head; GitLab keeps a ref per MR */
export function matchMergeRequests(output: string, branches: readonly string[]): Map<string, number> {
  const heads = new Map<string, string>();
  const newestAt = new Map<string, number>();
  for (const line of output.split('\n')) {
    const [sha, ref] = line.split('\t');
    if (sha === undefined || ref === undefined) continue;
    if (ref.startsWith(BRANCH_HEAD)) heads.set(ref.slice(BRANCH_HEAD.length), sha);
    const id = MR_HEAD.exec(ref)?.[1];
    if (id !== undefined) newestAt.set(sha, Math.max(Number(id), newestAt.get(sha) ?? 0));
  }
  const found = new Map<string, number>();
  for (const branch of branches) {
    const id = newestAt.get(heads.get(branch) ?? '');
    if (id !== undefined) found.set(branch, id);
  }
  return found;
}

export async function findMergeRequests(codeRoot: string, branches: readonly string[], lsRemote: LsRemote = gitLsRemote): Promise<Map<string, number>> {
  if (branches.length === 0) return new Map();
  return matchMergeRequests(await lsRemote(codeRoot, [...branches.map(branch => `${BRANCH_HEAD}${branch}`), MR_HEADS]), branches);
}

/** Best effort: without network or access the links simply do not appear */
export async function linkMergeRequests(store: Store, codeRoot: string, lsRemote: LsRemote = gitLsRemote): Promise<void> {
  try {
    const directions = (await store.read()).directions.filter(direction => direction.status !== 'done');
    const branches = [...new Set(directions.flatMap(direction => directionBranch(direction.tickets, store.profile) ?? []))];
    const found = await findMergeRequests(codeRoot, branches, lsRemote);
    if (found.size > 0) await store.applyMergeRequests(found);
  } catch {
    // the next check tries again
  }
}
