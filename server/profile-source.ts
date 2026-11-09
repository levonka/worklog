import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Profile, ProfileGitlab } from '../shared/model.ts';
import { setEnvValue } from './env-file.ts';
import { profileFromText } from './profile.ts';
import { quietGitEnv } from './git-env.ts';
import { errorMessage, writeTextAtomic } from './fs-utils.ts';
import { isRecord } from './guards.ts';

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
const MAX_PROFILE_BYTES = 10 * 1024 * 1024;
const GITLAB_FILE_PATH = /^\/(.+?)\/-\/(?:blob|raw)\/([^/]+)\/(.+)$/;
const SSH_ORIGIN = /^ssh:\/\/[^@/]+@([^:/]+)(?::(\d+))?\//;

/** a file in a GitLab project as its web link names it */
export interface GitlabFile {
  host: string;
  project: string;
  ref: string;
  file: string;
}

export interface FetchProfileOptions {
  profilePath: string;
  envFile: string;
  /** take the text from this local file and record `source` as where it came from */
  from?: string;
  /** SSH host and port from the profile already in place */
  gitlab?: ProfileGitlab;
  /** the work project, a clone from the same GitLab: its origin gives the SSH port */
  codeRoot?: string;
}

/** `https://<host>/<project>/-/blob|raw/<ref>/<file>`; the ref is one path segment */
export function parseGitlabFileUrl(url: string): GitlabFile | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const match = GITLAB_FILE_PATH.exec(parsed.pathname);
  if (match === null) return null;
  return { host: parsed.hostname, project: decodeURIComponent(match[1]), ref: decodeURIComponent(match[2]), file: decodeURIComponent(match[3]) };
}

/** the profile's SSH host and port, else the port of the project's origin on the same host, else port 22 */
export function gitlabSshUrl(file: GitlabFile, gitlab: ProfileGitlab | undefined, origin: string | null): string {
  const host = gitlab?.sshHost ?? file.host;
  const port = gitlab === undefined ? originPort(origin, file.host) : gitlab.sshPort;
  return `ssh://git@${host}${port === undefined ? '' : `:${port}`}/${file.project}.git`;
}

function originPort(origin: string | null, host: string): number | undefined {
  const match = origin === null ? null : SSH_ORIGIN.exec(origin);
  return match !== null && match[1] === host && match[2] !== undefined ? Number(match[2]) : undefined;
}

/** one file of a branch without checking out the repository */
export async function gitShowFile(repoUrl: string, ref: string, file: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-profile-'));
  const env = quietGitEnv();
  try {
    await run('git', ['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--no-checkout', '--branch', ref, repoUrl, dir], { env, timeout: GIT_TIMEOUT_MS });
    const { stdout } = await run('git', ['-C', dir, 'show', `HEAD:${file}`], { env, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_PROFILE_BYTES });
    return stdout;
  } catch (error) {
    throw new Error(`Не удалось забрать ${file} из ${repoUrl}: ${gitMessage(error)}. Проверь доступ к репозиторию по SSH или забери файл через браузер`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** the line that names the cause: git ends its stderr with generic advice */
function gitMessage(error: unknown): string {
  const stderr = isRecord(error) && typeof error.stderr === 'string' ? error.stderr : '';
  const lines = stderr.split('\n').map(line => line.trim()).filter(line => line !== '');
  const cause = lines.find(line => /^(ssh|fatal|error|remote):/.test(line)) ?? lines.at(-1);
  return (cause ?? (errorMessage(error))).replace(/\.+$/, '');
}

async function remoteOrigin(codeRoot: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', codeRoot, 'remote', 'get-url', 'origin']);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function sourceText(source: string, opts: FetchProfileOptions): Promise<string> {
  const file = parseGitlabFileUrl(source);
  if (file === null && !path.isAbsolute(source)) {
    throw new Error(`Не понял источник профиля: ${source} (нужен полный путь к файлу или ссылка на файл в GitLab: https://<gitlab>/<группа>/<проект>/-/blob/<ветка>/<путь>)`);
  }
  if (opts.from !== undefined) return readFile(opts.from, 'utf8');
  if (file === null) return readFile(source, 'utf8');
  const origin = opts.codeRoot === undefined ? null : await remoteOrigin(opts.codeRoot);
  return gitShowFile(gitlabSshUrl(file, opts.gitlab, origin), file.ref, file.file);
}

/** checks the profile, then replaces the local copy and records where it came from; a bad one changes nothing */
export async function fetchProfile(source: string, opts: FetchProfileOptions): Promise<Profile> {
  const text = await sourceText(source, opts);
  const profile = profileFromText(text, `из ${source}`);
  await writeTextAtomic(opts.profilePath, text);
  await setEnvValue(opts.envFile, 'WORKLOG_PROFILE_SOURCE', source);
  return profile;
}
