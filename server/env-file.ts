import { readFileSync } from 'node:fs';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { isErrorCode, writeTextAtomic } from './fs-utils.ts';

/** every setting the env file may hold */
export const SETTINGS = [
  'WORKLOG_NODE',
  'WORKLOG_CODE_ROOT',
  'WORKLOG_AGENT',
  'WORKLOG_CLAUDE_BIN',
  'WORKLOG_CODEX_BIN',
  'WORKLOG_CODEX_SESSIONS_DIR',
  'WORKLOG_TERMINAL',
  'WORKLOG_EDITOR',
  'WORKLOG_EDITOR_BIN',
  'WORKLOG_GITLAB_USER',
  'WORKLOG_PROFILE',
  'WORKLOG_PROFILE_SOURCE',
  'WORKLOG_DATA_DIR',
  'WORKLOG_PORT',
  'WORKLOG_IDLE_MS',
  'WORKLOG_CHROME_DIR',
  'WORKLOG_CLAUDE_PROJECTS_DIR',
  'WORKLOG_WARP_TAB_DIR',
  'WORKLOG_OPEN_BIN',
  'WORKLOG_OSASCRIPT_BIN',
  'WORKLOG_SUMMARY_MODEL',
  'WORKLOG_SUMMARY_TIMEOUT_MS',
  'WORKLOG_JIRA_P12',
  'WORKLOG_JIRA_CA',
  'WORKLOG_JIRA_KEYCHAIN',
  'WORKLOG_JIRA_TOKEN_KEYCHAIN',
  'WORKLOG_JIRA_POLL_MS',
] as const;
export type SettingName = (typeof SETTINGS)[number];

export function isSettingName(name: string): name is SettingName {
  return SETTINGS.some(setting => setting === name);
}

export function envFilePath(): string {
  return path.resolve(process.env.WORKLOG_ENV_FILE || path.join(homedir(), '.config', 'worklog', 'env'));
}

const LINE = /^(WORKLOG_[A-Z0-9_]+)=(.*)$/;
// a line meant as a setting that the format would otherwise drop without a word
const MEANT_AS_SETTING = /^\s*(export\s|WORKLOG_)/;
const QUOTED = /^(['"])(.*)\1$/;

function value(raw: string): string {
  const unquoted = QUOTED.exec(raw)?.[2] ?? raw;
  return unquoted.startsWith('~/') ? path.join(homedir(), unquoted.slice(2)) : unquoted;
}

/** `WORKLOG_NAME=value` lines; the value is everything after the first =, without one pair of quotes, ~/ is the home folder; the last line of a name wins */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\r$/, '');
    const match = LINE.exec(line);
    if (match !== null) values[match[1]] = value(match[2]);
    else if (MEANT_AS_SETTING.test(line)) throw new Error(`Не понял строку ${index + 1} файла настроек: ${line} (нужно WORKLOG_ИМЯ=значение)`);
  });
  return values;
}

export function readEnvFile(file: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(file, 'utf8'));
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return {};
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** the text with one line for the setting: the first one replaced, its repeats dropped; empty removes it */
export function withEnvValue(text: string, name: SettingName, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`Значение ${name} не может содержать перенос строки`);
  // a value the reader would unquote goes into the other pair of quotes
  const written = QUOTED.test(value) ? (value.startsWith('"') ? `'${value}'` : `"${value}"`) : value;
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const result: string[] = [];
  let found = false;
  for (const line of lines) {
    if (!line.startsWith(`${name}=`)) result.push(line);
    else if (!found) {
      found = true;
      if (value !== '') result.push(`${name}=${written}`);
    }
  }
  if (!found && value !== '') result.push(`${name}=${written}`);
  return result.length === 0 ? '' : `${result.join('\n')}\n`;
}

export async function setEnvValue(file: string, name: SettingName, value: string): Promise<void> {
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) throw error;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  await writeTextAtomic(file, withEnvValue(text, name, value));
  await chmod(file, 0o600);
}
