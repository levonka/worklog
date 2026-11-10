import { homedir } from 'node:os';
import path from 'node:path';
import type { Editor, Terminal } from '../shared/model.ts';
import { EDITORS, TERMINALS } from '../shared/model.ts';
import type { AgentSetup } from './agents.ts';
import { resolveAgents } from './agents.ts';
import type { EditorCommand } from './code-files.ts';
import { EDITOR_BINS } from './code-files.ts';
import type { SettingName } from './env-file.ts';
import { MAX_SUMMARY_TIMEOUT_MS, NO_EDITOR, envFilePath, readEnvFile, settingProblem } from './env-file.ts';
import type { JiraFiles } from './jira.ts';

const CONFIG_DIR = path.join(homedir(), '.config', 'worklog');
export const ENV_FILE = envFilePath();
const FILE_SETTINGS = readEnvFile(ENV_FILE);

/** the environment first, then ~/.config/worklog/env; empty is unset */
export function setting(name: SettingName): string | undefined {
  const raw = process.env[name] || FILE_SETTINGS[name] || undefined;
  const problem = raw === undefined ? null : settingProblem(name, raw);
  if (problem !== null) throw new Error(`Некорректное значение ${name}: ${raw} (${problem})`);
  return raw;
}

export const ROOT_DIR = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = path.resolve(setting('WORKLOG_DATA_DIR') || path.join(ROOT_DIR, 'data'));
export const PORT = intSetting('WORKLOG_PORT', 4317);
export const IDLE_MS = intSetting('WORKLOG_IDLE_MS', 180_000);
export const CHROME_DIR = path.resolve(setting('WORKLOG_CHROME_DIR') || path.join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome'));
export const STATIC_DIR = path.join(ROOT_DIR, 'web', 'dist', 'web', 'browser');
export const CLAUDE_PROJECTS_DIR = path.resolve(setting('WORKLOG_CLAUDE_PROJECTS_DIR') || path.join(homedir(), '.claude', 'projects'));
const codeRoot = setting('WORKLOG_CODE_ROOT');
/** the work project; none, opening files, the agent and MR links are off */
export const CODE_ROOT = codeRoot === undefined ? undefined : path.resolve(codeRoot);
export const EDITOR: EditorCommand | null = setting('WORKLOG_EDITOR') === NO_EDITOR ? null : editorCommand(oneOf('WORKLOG_EDITOR', EDITORS, 'jetbrains'));
export const TERMINAL: Terminal = oneOf('WORKLOG_TERMINAL', TERMINALS, 'terminal');
export const WARP_TAB_DIR = path.resolve(setting('WORKLOG_WARP_TAB_DIR') || path.join(homedir(), '.warp', 'tab_configs'));
export const OPEN_BIN = setting('WORKLOG_OPEN_BIN') || '/usr/bin/open';
export const OSASCRIPT_BIN = setting('WORKLOG_OSASCRIPT_BIN') || '/usr/bin/osascript';
export const AGENT_SETUP: AgentSetup = resolveAgents({ agent: setting('WORKLOG_AGENT'), claudeBin: setting('WORKLOG_CLAUDE_BIN'), codexBin: setting('WORKLOG_CODEX_BIN') });
export const CODEX_SESSIONS_DIR = path.resolve(setting('WORKLOG_CODEX_SESSIONS_DIR') || path.join(homedir(), '.codex', 'sessions'));
/** none: Claude takes sonnet, Codex its own default */
export const SUMMARY_MODEL = setting('WORKLOG_SUMMARY_MODEL');
export const SUMMARY_TIMEOUT_MS = intSetting('WORKLOG_SUMMARY_TIMEOUT_MS', MAX_SUMMARY_TIMEOUT_MS);

export const PROFILE_PATH = path.resolve(setting('WORKLOG_PROFILE') || path.join(CONFIG_DIR, 'profile.json'));
/** where the profile was fetched from: a GitLab file link or a full path */
export const PROFILE_SOURCE = setting('WORKLOG_PROFILE_SOURCE');
export const GITLAB_USER = setting('WORKLOG_GITLAB_USER');
export const JIRA_FILES: JiraFiles = {
  p12Path: path.resolve(setting('WORKLOG_JIRA_P12') || path.join(CONFIG_DIR, 'jira.p12')),
  caPath: path.resolve(setting('WORKLOG_JIRA_CA') || path.join(CONFIG_DIR, 'jira-ca.crt')),
  keychainService: setting('WORKLOG_JIRA_KEYCHAIN') || 'worklog-jira-p12',
  tokenService: setting('WORKLOG_JIRA_TOKEN_KEYCHAIN') || 'worklog-jira-token',
};
export const JIRA_POLL_MS = intSetting('WORKLOG_JIRA_POLL_MS', 300_000);
export const JIRA_ON = setting('WORKLOG_JIRA') !== 'off';

function editorCommand(name: Editor): EditorCommand {
  return { name, bin: setting('WORKLOG_EDITOR_BIN') || EDITOR_BINS[name] };
}

function oneOf<T extends string>(name: SettingName, values: readonly T[], fallback: T): T {
  // setting() has already refused a value outside the list
  const raw = setting(name);
  return values.find(value => value === raw) ?? fallback;
}

/** a number setting; setting() has already refused anything but digits within the limit */
function intSetting(name: SettingName, fallback: number): number {
  const raw = setting(name);
  return raw === undefined ? fallback : Number(raw);
}
