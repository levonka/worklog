import { execFile } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Agent, AgentRequest, AgentRun, BranchPlace, Terminal } from '../shared/model.ts';
import { isBranchName, TERMINAL_OPEN_LABELS } from '../shared/model.ts';
import { readdirIfExists, writeTextAtomic, errorMessage } from './fs-utils.ts';
import { HttpError, STATUS_INTERNAL_ERROR } from './http.ts';
import type { Store } from './store.ts';
import { ValidationError } from './store.ts';

const run = promisify(execFile);

export interface AgentConfig {
  /** where the prompts are kept: data/runs */
  runsDir: string;
  /** the working copy the agent's session starts in */
  codeRoot: string;
  /** the installed agents and their binaries */
  bins: Partial<Record<Agent, string>>;
  /** the agent a request without one gets */
  defaultAgent: Agent;
  terminal: Terminal;
  /** ~/.warp/tab_configs */
  warpTabDir: string;
  /** /usr/bin/open; tests put a recorder here */
  openBin: string;
  /** /usr/bin/osascript for iTerm2 and Terminal.app; tests put a recorder here */
  osascriptBin: string;
}

const TAB_PREFIX = 'worklog-run-';
const TAB_EXT = '.toml';
const TAB_FILE = /^worklog-run-[0-9a-z]+\.toml$/;
// Warp opens a config within a second; an older one was never opened and only clutters its «+» menu
const STALE_TAB_MS = 10 * 60_000;

/** the shell sees the text as one word, nothing in it expands */
function shellQuoted(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

// a JSON string is a valid TOML basic string: the same escapes, control characters escaped
function tomlString(text: string): string {
  return JSON.stringify(text);
}

export function promptFile(config: AgentConfig, runId: string): string {
  return path.join(config.runsDir, `${runId}.md`);
}

export function tabFile(config: AgentConfig, runId: string): string {
  return path.join(config.warpTabDir, `${TAB_PREFIX}${runId}${TAB_EXT}`);
}

/** an interactive session of the run's agent with the prompt from the file */
function agentCommand(config: AgentConfig, run: AgentRun): string {
  const agent = run.agent ?? 'claude';
  const bin = shellQuoted(config.bins[agent] ?? agent);
  const prompt = `"$(cat ${shellQuoted(promptFile(config, run.id))})"`;
  const folder = agent === 'codex' ? ` -C ${shellQuoted(config.codeRoot)}` : '';
  return `WORKLOG_RUN_ID=${run.id} ${bin}${folder} ${prompt}`;
}

/** what iTerm2 and Terminal.app type into the new session */
export function terminalCommand(config: AgentConfig, run: AgentRun): string {
  return `cd ${shellQuoted(config.codeRoot)} && ${agentCommand(config, run)}`;
}

// the command arrives as the script's argument: nothing of it is parsed as AppleScript
const TERMINAL_SCRIPTS: Record<'iterm' | 'terminal', string[]> = {
  terminal: ['on run argv', 'tell application "Terminal"', 'do script (item 1 of argv)', 'activate', 'end tell', 'end run'],
  iterm: [
    'on run argv',
    'tell application "iTerm"',
    'activate',
    'if (count of windows) = 0 then',
    'create window with default profile',
    'else',
    'tell current window to create tab with default profile',
    'end if',
    'tell current session of current window to write text (item 1 of argv)',
    'end tell',
    'end run',
  ],
};

export function terminalScript(terminal: 'iterm' | 'terminal'): string[] {
  return TERMINAL_SCRIPTS[terminal];
}

/** the tab removes its own config first, then runs the agent with the prompt from the file */
export function tabConfig(config: AgentConfig, run: AgentRun): string {
  const command = [`rm -f ${shellQuoted(tabFile(config, run.id))};`, agentCommand(config, run)].join(' ');
  const title = tomlString(`✦ ${run.title}`);
  return [
    `name = ${title}`,
    `title = ${title}`,
    '',
    '[[panes]]',
    'id = "main"',
    'type = "terminal"',
    `directory = ${tomlString(config.codeRoot)}`,
    `commands = [${tomlString(command)}]`,
    '',
  ].join('\n');
}

async function removeStaleTabs(config: AgentConfig, now: number): Promise<void> {
  // an unreadable folder fails the launch here, not silently: the tab file goes there next
  const names = await readdirIfExists(config.warpTabDir);
  await Promise.all(
    names
      .filter(name => TAB_FILE.test(name))
      .map(async name => {
        const file = path.join(config.warpTabDir, name);
        const info = await stat(file).catch(() => null);
        if (info !== null && now - info.mtimeMs > STALE_TAB_MS) await rm(file, { force: true });
      }),
  );
}

async function openWarp(config: AgentConfig, started: AgentRun, now: Date): Promise<void> {
  await removeStaleTabs(config, now.getTime());
  await writeTextAtomic(tabFile(config, started.id), tabConfig(config, started));
  await run(config.openBin, [`warp://tab_config/${TAB_PREFIX}${started.id}`]);
}

const NOT_ALLOWED = '(-1743)';

/** what the program said, not the whole command line execFile puts into the message */
function launchFailure(error: unknown): string {
  const stderr = error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
  if (stderr.includes(NOT_ALLOWED)) return 'нет разрешения управлять им: Системные настройки → Конфиденциальность и безопасность → Автоматизация';
  if (stderr !== '') return stderr;
  return errorMessage(error).trim();
}

/** records the run, then opens the chosen terminal with its session; on failure nothing of it stays */
export async function launchAgent(store: Store, config: AgentConfig, request: AgentRequest, now: Date = new Date()): Promise<AgentRun> {
  const agent = request.agent ?? config.defaultAgent;
  if (config.bins[agent] === undefined) throw new ValidationError(`Агент не установлен: ${agent}`);
  const { run: started, prompt } = await store.startRun({ ...request, agent }, now);
  const terminal = config.terminal;
  try {
    await writeTextAtomic(promptFile(config, started.id), prompt);
    if (terminal === 'warp') await openWarp(config, started, now);
    else await run(config.osascriptBin, [...terminalScript(terminal).flatMap(line => ['-e', line]), terminalCommand(config, started)]);
  } catch (error) {
    await Promise.all([rm(promptFile(config, started.id), { force: true }), rm(tabFile(config, started.id), { force: true }), store.discardRun(started.id)]).catch(
      () => undefined,
    );
    // the reason must reach the window, not the generic «internal error»
    throw new HttpError(STATUS_INTERNAL_ERROR, `Не удалось открыть: ${TERMINAL_OPEN_LABELS[terminal]} (${launchFailure(error)})`);
  }
  return started;
}

async function hasRef(codeRoot: string, ref: string): Promise<boolean> {
  try {
    await run('git', ['-C', codeRoot, 'show-ref', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

/** where the branch already is; `none`: the agent creates it from origin/dev */
export async function branchPlace(codeRoot: string, name: string): Promise<BranchPlace> {
  if (!isBranchName(name)) throw new ValidationError(`Некорректное имя ветки: ${name}`);
  if (await hasRef(codeRoot, `refs/heads/${name}`)) return 'local';
  if (await hasRef(codeRoot, `refs/remotes/origin/${name}`)) return 'remote';
  return 'none';
}
