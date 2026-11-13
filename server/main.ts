import { createApp } from './app.ts';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { UPDATE_CHECK_MS } from '../shared/model.ts';
import {
  CHROME_DIR,
  AGENT_SETUP,
  CODEX_SESSIONS_DIR,
  CLAUDE_PROJECTS_DIR,
  CODE_ROOT,
  DATA_DIR,
  EDITOR,
  IDLE_MS,
  JIRA_FILES,
  JIRA_ON,
  JIRA_POLL_MS,
  OPEN_BIN,
  OSASCRIPT_BIN,
  PORT,
  PROFILE_PATH,
  ROOT_DIR,
  STATIC_DIR,
  SUMMARY_MODEL,
  SUMMARY_TIMEOUT_MS,
  TERMINAL,
  UPDATE_CHECK_ON,
  UPDATE_RUN_FILE,
  WARP_TAB_DIR,
} from './config.ts';
import { chromeProfileDir } from './favicons.ts';
import { isErrorCode } from './fs-utils.ts';
import { createJiraFetch, jiraConfig } from './jira.ts';
import { loadProfile } from './profile.ts';
import { stopSummaryRuns } from './summarizer.ts';
import { currentVersion, gitIn, updateFacts } from './update-check.ts';

const { profile, error: profileError } = await loadProfile(PROFILE_PATH);
if (profileError !== null) console.error(profileError);
const profileJira = profile?.jira;
const clone = gitIn(ROOT_DIR);

/** server/update-main.ts, detached: it outlives this server, stops it and starts the new version */
function launchUpdate(startedAt: string): void {
  const logs = path.join(ROOT_DIR, 'logs');
  mkdirSync(logs, { recursive: true });
  const out = openSync(path.join(logs, 'update.log'), 'a');
  try {
    const args = [path.join(ROOT_DIR, 'server', 'update-main.ts'), '--pid', String(process.pid), '--started-at', startedAt];
    const child = spawn(process.execPath, args, { cwd: ROOT_DIR, env: process.env, detached: true, stdio: ['ignore', out, out] });
    // a node binary removed by an upgrade fails the spawn: the live server must not crash on it
    child.on('error', error => console.error('Обновление не запустилось:', error.message));
    if (child.pid === undefined) throw new Error('процесс обновления не запустился');
    child.unref();
  } finally {
    closeSync(out);
  }
}

try {
  const app = await createApp({
    profile,
    seedExample: true,
    dataDir: DATA_DIR,
    port: PORT,
    staticDir: STATIC_DIR,
    idleMs: IDLE_MS,
    onIdle: () => {
      stopSummaryRuns();
      process.exit(0);
    },
    chromeProfileDir: await chromeProfileDir(CHROME_DIR),
    // run from worklog: the project folder has SessionStart hooks
    summary: {
      ...(AGENT_SETUP.bins.claude === undefined ? {} : { claudeProjectsDir: CLAUDE_PROJECTS_DIR }),
      ...(AGENT_SETUP.bins.codex === undefined ? {} : { codexSessionsDir: CODEX_SESSIONS_DIR }),
      agent: { agent: AGENT_SETUP.main, bin: AGENT_SETUP.bins[AGENT_SETUP.main] ?? AGENT_SETUP.main, model: SUMMARY_MODEL, cwd: ROOT_DIR, timeoutMs: SUMMARY_TIMEOUT_MS },
    },
    ...(CODE_ROOT === undefined
      ? {}
      : {
          code: { root: CODE_ROOT, editor: EDITOR },
          agent: {
            runsDir: path.join(DATA_DIR, 'runs'),
            codeRoot: CODE_ROOT,
            bins: AGENT_SETUP.bins,
            defaultAgent: AGENT_SETUP.main,
            terminal: TERMINAL,
            warpTabDir: WARP_TAB_DIR,
            openBin: OPEN_BIN,
            osascriptBin: OSASCRIPT_BIN,
          },
          ...(profile?.gitlab?.mergeRequestsUrl === undefined ? {} : { mergeRequests: { codeRoot: CODE_ROOT, pollMs: JIRA_POLL_MS } }),
        }),
    jira: profileJira === undefined || !JIRA_ON ? undefined : { connect: () => createJiraFetch(jiraConfig(profileJira, JIRA_FILES)), pollMs: JIRA_POLL_MS },
    update: UPDATE_CHECK_ON ? { facts: () => updateFacts(clone), intervalMs: UPDATE_CHECK_MS, version: await currentVersion(clone), runFile: UPDATE_RUN_FILE, launch: launchUpdate } : undefined,
  });
  console.log(`Worklog: http://localhost:${new URL(app.url).port}`);
} catch (error) {
  if (!isErrorCode(error, 'EADDRINUSE')) throw error;
  console.error(`Worklog уже запущен на порту ${PORT}`);
  process.exit(1);
}
