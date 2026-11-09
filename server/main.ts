import { createApp } from './app.ts';
import path from 'node:path';
import {
  CHROME_DIR,
  AGENT_SETUP,
  CODEX_SESSIONS_DIR,
  CLAUDE_PROJECTS_DIR,
  CODE_ROOT,
  DATA_DIR,
  EDITOR,
  EDITOR_BIN,
  IDLE_MS,
  JIRA_FILES,
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
  WARP_TAB_DIR,
} from './config.ts';
import { chromeProfileDir } from './favicons.ts';
import { isErrorCode } from './fs-utils.ts';
import { createJiraFetch, jiraConfig } from './jira.ts';
import { loadProfile } from './profile.ts';
import { stopSummaryRuns } from './summarizer.ts';

const { profile, error: profileError } = await loadProfile(PROFILE_PATH);
if (profileError !== null) console.error(profileError);
const profileJira = profile?.jira;

try {
  const app = await createApp({
    profile,
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
          code: { root: CODE_ROOT, editor: EDITOR, editorBin: EDITOR_BIN },
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
    jira: profileJira === undefined ? undefined : { connect: () => createJiraFetch(jiraConfig(profileJira, JIRA_FILES)), pollMs: JIRA_POLL_MS },
  });
  console.log(`Worklog: http://localhost:${new URL(app.url).port}`);
} catch (error) {
  if (!isErrorCode(error, 'EADDRINUSE')) throw error;
  console.error(`Worklog уже запущен на порту ${PORT}`);
  process.exit(1);
}
