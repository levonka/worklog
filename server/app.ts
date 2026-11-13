import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentConfig } from './agent-launch.ts';
import { createApiRoutes } from './api.ts';
import type { CodeConfig } from './code-files.ts';
import type { SummaryConfig } from './daily.ts';
import { snapshotData } from './data-git.ts';
import { STATUS_NOT_FOUND, assertLocalHost, assertSameOrigin, matchRoute, readJsonBody, sendError, sendJson, sendText } from './http.ts';
import type { Route } from './http.ts';
import { createFavicons, serveFavicon } from './favicons.ts';
import type { Favicons } from './favicons.ts';
import { History } from './history.ts';
import type { Profile } from '../shared/model.ts';
import { localDate } from '../shared/model.ts';
import type { JiraFetch } from './jira.ts';
import { createJiraPoller } from './jira-poller.ts';
import type { LsRemote } from './merge-requests.ts';
import { linkMergeRequests } from './merge-requests.ts';
import { createLiveHub } from './live.ts';
import type { LiveHub } from './live.ts';
import { serveStatic } from './static.ts';
import { Store } from './store.ts';
import type { UpdateFacts } from '../shared/model.ts';
import { createUpdateChecker } from './update-check.ts';
import { updateRunning } from './update-routes.ts';

const HOST = '127.0.0.1';
const API_PREFIX = '/api/';
const LIVE_PATH = '/api/live';
const FAVICON_PATH = '/api/favicon';
const FAVICON_SNAPSHOT_MS = 10 * 60_000;
// how soon after midnight today's repeating todos appear
const REPEAT_CHECK_MS = 5 * 60_000;
// how often the server checks whether today's snapshot of data is due
const SNAPSHOT_CHECK_MS = 60 * 60_000;

export interface AppOptions {
  dataDir: string;
  port: number;
  staticDir: string;
  idleMs: number;
  onIdle?: () => void;
  /** Chrome profile whose favicon cache gives the links their icons; none, no icons */
  chromeProfileDir?: string;
  /** where sessions come from and how claude runs; none, the summary button answers 503 */
  summary?: SummaryConfig;
  /** the code the notes link to and the editor that opens it; none, files neither open nor get checked */
  code?: CodeConfig;
  /** how an agent's Warp tab is opened; none, launching answers 503 */
  agent?: AgentConfig;
  repeatCheckMs?: number;
  snapshotCheckMs?: number;
  /** how to build the Jira client and how often to poll; none, Jira is off */
  jira?: { connect: () => Promise<JiraFetch | string>; pollMs: number };
  /** where the branches' merge requests are looked up; none, MR links are not added */
  mergeRequests?: { codeRoot: string; pollMs: number; lsRemote?: LsRemote };
  /** the company profile; none, no Jira, branches, stands or platforms */
  profile?: Profile | null;
  /** put the onboarding example into empty data on start: the real app does, tests ask for it */
  seedExample?: boolean;
  /** the look at GitHub for a newer Worklog and the update by the button; none, both are off */
  update?: {
    facts: () => Promise<UpdateFacts | null>;
    intervalMs: number;
    version: string | null;
    runFile: string;
    /** starts server/update-main.ts; throws when it could not */
    launch: (startedAt: string) => void;
    alive?: (pid: number) => boolean;
    now?: () => Date;
  };
}

export interface App {
  url: string;
  close(): Promise<void>;
}

export async function createApp(opts: AppOptions): Promise<App> {
  // before the store that records undo history: this conversion is not the user's step to undo; broken data answers 500 later, not here
  const setup = new Store(opts.dataDir, { profile: opts.profile ?? null });
  await setup.releaseJiraStages().catch(() => 0);
  if (opts.seedExample === true) await setup.seedExample().catch(() => false);
  const live = createLiveHub({ dataDir: opts.dataDir, idleMs: opts.idleMs, onIdle: opts.onIdle ?? (() => {}) });
  const history = new History();
  const store = new Store(opts.dataDir, { onCommit: changes => history.record(changes), profile: opts.profile ?? null });
  const jira = opts.jira === undefined ? undefined : createJiraPoller({ store, connect: opts.jira.connect, pollMs: opts.jira.pollMs, onHealth: live.notify });
  const mr = opts.mergeRequests;
  let mrRunning: Promise<void> | null = null;
  const checkMergeRequests =
    mr === undefined
      ? undefined
      : (): Promise<void> => {
          mrRunning ??= linkMergeRequests(store, mr.codeRoot, mr.lsRemote).finally(() => {
            mrRunning = null;
          });
          return mrRunning;
        };
  // a change of what the check found reaches the windows like a change of data
  const checker = opts.update === undefined ? undefined : createUpdateChecker({ facts: opts.update.facts, intervalMs: opts.update.intervalMs, onChange: live.notify, busy: (): Promise<boolean> => updateRunning(update) });
  const update = opts.update === undefined || checker === undefined ? undefined : { ...opts.update, checker, notify: live.notify };
  const routes = createApiRoutes(store, history, live.clientCount, { summary: opts.summary, code: opts.code, agent: opts.agent, jira, mergeRequests: checkMergeRequests, update });
  const favicons = createFavicons({ profileDir: opts.chromeProfileDir ?? null, snapshotMs: FAVICON_SNAPSHOT_MS });
  let port = 0;
  const server = createServer((req, res) => {
    handle(req, res, { routes, live, favicons, staticDir: opts.staticDir, port: () => port }).catch(error => sendError(res, error));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port, HOST, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    live.close();
    await favicons.close();
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === 'string') {
    live.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await favicons.close();
    throw new Error('Сервер не получил TCP-порт');
  }

  port = address.port;
  // only once the port is ours: a second server started by mistake must not touch the live one's run
  await store.abandonSummaryRun().catch(() => undefined);
  const applyRepeats = (): void => {
    store.applyRepeats().catch(error => console.error('Повторяющиеся дела:', error));
  };
  applyRepeats();
  const repeatTimer = setInterval(applyRepeats, opts.repeatCheckMs ?? REPEAT_CHECK_MS);
  repeatTimer.unref();
  const snapshot = (): void => {
    snapshotData(opts.dataDir, localDate(new Date())).catch(error => console.error('Снимок данных:', error));
  };
  snapshot();
  const snapshotTimer = setInterval(snapshot, opts.snapshotCheckMs ?? SNAPSHOT_CHECK_MS);
  snapshotTimer.unref();
  jira?.start();
  checker?.start();
  let mrTimer: NodeJS.Timeout | undefined;
  if (mr !== undefined && checkMergeRequests !== undefined) {
    void checkMergeRequests();
    mrTimer = setInterval(() => void checkMergeRequests(), mr.pollMs);
    mrTimer.unref();
  }

  return {
    url: `http://${HOST}:${address.port}`,
    close: async () => {
      clearInterval(repeatTimer);
      clearInterval(snapshotTimer);
      jira?.close();
      checker?.close();
      clearInterval(mrTimer);
      await new Promise<void>((resolve, reject) => {
        live.close();
        server.close(error => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      await favicons.close();
    },
  };
}

interface HandlerContext {
  routes: readonly Route[];
  live: LiveHub;
  favicons: Favicons;
  staticDir: string;
  port(): number;
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext): Promise<void> {
  assertLocalHost(req, ctx.port());
  assertSameOrigin(req, ctx.port());
  ctx.live.touch();
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${HOST}`);

  if (method === 'GET' && url.pathname === LIVE_PATH) {
    ctx.live.handle(req, res);
    return;
  }

  if (method === 'GET' && url.pathname === FAVICON_PATH) {
    await serveFavicon(req, res, url.searchParams, ctx.favicons);
    return;
  }

  if (url.pathname.startsWith(API_PREFIX)) {
    const matched = matchRoute(ctx.routes, method, url.pathname);
    if (!matched) {
      sendJson(res, STATUS_NOT_FOUND, { error: `Маршрут не найден: ${method} ${url.pathname}` });
      return;
    }
    const result = await matched.route.handler({
      params: matched.params,
      query: url.searchParams,
      readBody: () => readJsonBody(req),
    });
    sendJson(res, result.status, result.body);
    return;
  }

  if (method === 'GET') await serveStatic(ctx.staticDir, url.pathname, res);
  else sendText(res, STATUS_NOT_FOUND, 'Не найдено');
}
