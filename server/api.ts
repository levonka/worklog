import { homedir } from 'node:os';
import type { Agent, JiraHealth } from '../shared/model.ts';
import { AGENT_CONTEXT_PARTS, AGENT_TEMPLATES, AGENTS, LINK_KINDS, STATUSES } from '../shared/model.ts';
import type { AgentConfig } from './agent-launch.ts';
import { installedAgents } from './agents.ts';
import { branchPlace, launchAgent } from './agent-launch.ts';
import type { CodeConfig } from './code-files.ts';
import { missingFiles, openInEditor } from './code-files.ts';
import type { SummaryConfig } from './daily.ts';
import { startSummary } from './daily.ts';
import { isNoteFile, isNoteUrl, isRecord } from './guards.ts';
import type { History, HistoryResult } from './history.ts';
import type { JiraPoller } from './jira-poller.ts';
import { HttpError } from './http.ts';
import type { Route, RouteContext, RouteResult } from './http.ts';
import type { NotePatch, TodoPatch } from './store.ts';
import { Store, ValidationError } from './store.ts';

const OK = 200;
const CREATED = 201;
const NO_CONTENT = 204;
const ACCEPTED = 202;
const CONFLICT = 409;
const UNAVAILABLE = 503;
const DAILY_TEXT = /^\/api\/daily\/text$/;
const UNKNOWN_STATUS = 'неизвестный статус';
const JIRA_OFF: JiraHealth = { state: 'off', message: 'Jira не настроена', checkedAt: null, polling: false };

type Params = Record<string, unknown>;

export interface ApiOptions {
  summary?: SummaryConfig;
  code?: CodeConfig;
  agent?: AgentConfig;
  jira?: JiraPoller;
  /** links the merge requests of the branches; run along with the Jira refresh */
  mergeRequests?: () => Promise<void>;
}

export function createApiRoutes(store: Store, history: History, clientCount: () => number, { summary, code, agent, jira, mergeRequests }: ApiOptions = {}): Route[] {
  const routes = [
    route('GET', /^\/api\/health$/, async () => ({ status: OK, body: { ok: true, clients: clientCount() } })),
    route('GET', /^\/api\/state$/, async () => ({ status: OK, body: await store.read() })),
    route('GET', /^\/api\/profile$/, async () => ({ status: OK, body: { profile: store.profile } })),

    route('POST', /^\/api\/directions$/, async ctx => {
      const body = await readObject(ctx);
      const direction = await store.createDirection({
        title: requiredString(body, 'title'),
        status: optionalOneOf(body, 'status', STATUSES, UNKNOWN_STATUS),
        ticketKeys: optionalStringArray(body, 'tickets'),
        waitingFor: optionalString(body, 'waitingFor'),
      });
      return { status: CREATED, body: direction };
    }),
    route('PATCH', /^\/api\/directions\/([^/]+)$/, async ctx => {
      const [id] = ctx.params;
      const body = await readObject(ctx);
      const direction = await store.patchDirection(id, {
        title: optionalString(body, 'title'),
        waitingFor: nullableString(body, 'waitingFor'),
      });
      return { status: OK, body: direction };
    }),
    route('POST', /^\/api\/directions\/([^/]+)\/status$/, async ctx => {
      const [id] = ctx.params;
      const body = await readObject(ctx);
      const status = requiredOneOf(body, 'status', STATUSES, UNKNOWN_STATUS);
      const direction = await store.setStatus(id, status, {
        waitingFor: nullableString(body, 'waitingFor'),
        index: optionalInteger(body, 'index'),
      });
      return { status: OK, body: direction };
    }),
    route('POST', /^\/api\/directions\/([^/]+)\/unmark$/, async ctx => ({ status: OK, body: await store.clearMark(ctx.params[0]) })),
    route('DELETE', /^\/api\/directions\/([^/]+)$/, async ctx => {
      await store.deleteDirection(ctx.params[0]);
      return { status: NO_CONTENT };
    }),
    route('POST', /^\/api\/directions\/([^/]+)\/events$/, async ctx => {
      const body = await readObject(ctx);
      const event = await store.addEvent(ctx.params[0], requiredString(body, 'text'), 'manual');
      return { status: CREATED, body: event };
    }),
    route('POST', /^\/api\/directions\/([^/]+)\/tickets$/, async ctx => {
      const body = await readObject(ctx);
      const ticket = await store.addTicket(ctx.params[0], requiredString(body, 'key'));
      return { status: CREATED, body: ticket };
    }),
    route('DELETE', /^\/api\/directions\/([^/]+)\/tickets\/([^/]+)$/, async ctx => {
      await store.removeTicket(ctx.params[0], ctx.params[1]);
      return { status: NO_CONTENT };
    }),
    route('POST', /^\/api\/directions\/([^/]+)\/links$/, async ctx => {
      const body = await readObject(ctx);
      const link = await store.addLink(ctx.params[0], {
        url: requiredString(body, 'url'),
        title: optionalString(body, 'title'),
        kind: optionalOneOf(body, 'kind', LINK_KINDS, 'неизвестный вид ссылки'),
        description: optionalString(body, 'description'),
      });
      return { status: CREATED, body: link };
    }),
    route('PATCH', /^\/api\/directions\/([^/]+)\/links$/, async ctx => {
      const body = await readObject(ctx);
      const link = await store.setLinkDescription(ctx.params[0], requiredString(body, 'url'), requiredDescription(body));
      return { status: OK, body: link };
    }),
    route('DELETE', /^\/api\/directions\/([^/]+)\/links$/, async ctx => {
      await store.removeLink(ctx.params[0], requiredQuery(ctx, 'url'));
      return { status: NO_CONTENT };
    }),

    route('POST', /^\/api\/todos$/, async ctx => {
      const body = await readObject(ctx);
      const todo = await store.addTodo({
        text: requiredString(body, 'text'),
        directionId: optionalString(body, 'directionId'),
        requestedBy: optionalString(body, 'requestedBy'),
        due: optionalString(body, 'due'),
        url: optionalString(body, 'url'),
        time: optionalString(body, 'time'),
      });
      return { status: CREATED, body: todo };
    }),
    route('PATCH', /^\/api\/todos\/([^/]+)$/, async ctx => {
      const [id] = ctx.params;
      const body = await readObject(ctx);
      const patch: TodoPatch = {
        done: optionalBoolean(body, 'done'),
        text: optionalString(body, 'text'),
        directionId: nullableString(body, 'directionId'),
        requestedBy: nullableString(body, 'requestedBy'),
        due: nullableString(body, 'due'),
        url: nullableString(body, 'url'),
        time: nullableString(body, 'time'),
      };
      return { status: OK, body: await store.updateTodo(id, patch) };
    }),
    route('POST', /^\/api\/todos\/([^/]+)\/move$/, async ctx => {
      const body = await readObject(ctx);
      await store.moveTodo(ctx.params[0], requiredInteger(body, 'index'));
      return { status: NO_CONTENT };
    }),
    route('DELETE', /^\/api\/todos\/([^/]+)$/, async ctx => {
      await store.deleteTodo(ctx.params[0]);
      return { status: NO_CONTENT };
    }),

    route('POST', /^\/api\/link-groups$/, async ctx => {
      const body = await readObject(ctx);
      const group = await store.addQuickLink(requiredString(body, 'groupTitle'), {
        title: requiredString(body, 'title'),
        url: requiredString(body, 'url'),
        description: optionalString(body, 'description'),
      });
      return { status: CREATED, body: group };
    }),
    route('PATCH', /^\/api\/link-groups\/([^/]+)\/links$/, async ctx => {
      const body = await readObject(ctx);
      const link = await store.setQuickLinkDescription(ctx.params[0], requiredString(body, 'url'), requiredDescription(body));
      return { status: OK, body: link };
    }),

    route('POST', /^\/api\/notes$/, async ctx => {
      const body = await readObject(ctx);
      const note = await store.createNote({ ...notePatch(body), title: requiredString(body, 'title') });
      return { status: CREATED, body: note };
    }),
    route('PATCH', /^\/api\/notes\/([^/]+)$/, async ctx => ({ status: OK, body: await store.updateNote(ctx.params[0], notePatch(await readObject(ctx))) })),
    route('DELETE', /^\/api\/notes\/([^/]+)$/, async ctx => {
      await store.deleteNote(ctx.params[0]);
      return { status: NO_CONTENT };
    }),
    route('DELETE', /^\/api\/link-groups\/([^/]+)\/links$/, async ctx => {
      await store.removeQuickLink(ctx.params[0], requiredQuery(ctx, 'url'));
      return { status: NO_CONTENT };
    }),

    route('PUT', DAILY_TEXT, async ctx => {
      const body = await readObject(ctx);
      const text = body.text === null ? null : requiredString(body, 'text');
      return { status: OK, body: await store.setDraftText(requiredString(body, 'periodStart'), text) };
    }),
    route('DELETE', /^\/api\/daily\/items\/([^/]+)$/, async ctx => {
      await store.removeSummaryItem(ctx.params[0]);
      return { status: NO_CONTENT };
    }),
    route('PATCH', /^\/api\/daily\/items\/([^/]+)$/, async ctx => {
      const body = await readObject(ctx);
      const directionId = body.directionId === null ? null : requiredString(body, 'directionId');
      return { status: OK, body: await store.setSummaryItemDirection(ctx.params[0], directionId) };
    }),
    route('POST', /^\/api\/daily\/candidates\/([^/]+)\/accept$/, async ctx => ({ status: CREATED, body: await store.acceptCandidate(ctx.params[0]) })),
    route('DELETE', /^\/api\/daily\/candidates\/([^/]+)$/, async ctx => {
      await store.dismissCandidate(ctx.params[0]);
      return { status: NO_CONTENT };
    }),
    route('POST', /^\/api\/agent\/runs\/([^/]+)\/finish$/, async ctx => ({ status: OK, body: await store.finishRun(ctx.params[0]) })),
    route('POST', /^\/api\/daily\/held$/, async ctx => {
      const body = await readObject(ctx);
      const daily = await store.holdDaily({ periodStart: requiredString(body, 'periodStart'), text: requiredString(body, 'text') });
      return { status: CREATED, body: daily };
    }),
  ];
  return [
    ...routes.map(item => route(item.method, item.pattern, ctx => history.track(() => item.handler(ctx), item.pattern === DAILY_TEXT ? 'daily-text' : null))),
    // outside history: undo must not take back the «running» mark of a run still in progress
    route('POST', /^\/api\/daily\/summary$/, async () => {
      if (summary === undefined) throw new HttpError(UNAVAILABLE, 'Выжимка из сессий не настроена');
      await startSummary(store, summary);
      return { status: ACCEPTED, body: { started: true } };
    }),
    // outside history as well: undo cannot close the Warp tab
    route('POST', /^\/api\/agent\/runs$/, async ctx => {
      if (agent === undefined) throw new HttpError(UNAVAILABLE, 'Запуск агента не настроен');
      const body = await readObject(ctx);
      const run = await launchAgent(store, agent, {
        template: requiredOneOf(body, 'template', AGENT_TEMPLATES, 'неизвестный шаблон'),
        directionId: optionalString(body, 'directionId'),
        todoId: optionalString(body, 'todoId'),
        include: (optionalStringArray(body, 'include') ?? []).map(part => oneOfValue(part, 'include', AGENT_CONTEXT_PARTS, 'неизвестная часть контекста')),
        extra: optionalString(body, 'extra') ?? '',
        branch: requiredString(body, 'branch'),
        ...agentOf(body),
      });
      return { status: CREATED, body: run };
    }),
    route('GET', /^\/api\/agent\/launcher$/, async () => {
      if (agent === undefined) throw new HttpError(UNAVAILABLE, 'Запуск агента не настроен');
      return { status: OK, body: { terminal: agent.terminal, codeRoot: homeShortened(agent.codeRoot), agents: installedAgents(agent.bins), defaultAgent: agent.defaultAgent } };
    }),
    route('GET', /^\/api\/agent\/branch$/, async ctx => {
      if (agent === undefined) throw new HttpError(UNAVAILABLE, 'Запуск агента не настроен');
      return { status: OK, body: { place: await branchPlace(agent.codeRoot, requiredQuery(ctx, 'name')) } };
    }),
    route('POST', /^\/api\/open-file$/, async ctx => {
      if (code === undefined) throw new HttpError(UNAVAILABLE, 'Открытие файлов не настроено');
      if (code.editor === null) throw new HttpError(UNAVAILABLE, 'Редактор не выбран: worklog config set WORKLOG_EDITOR jetbrains|vscode|cursor');
      const body = await readObject(ctx);
      const line = optionalInteger(body, 'line');
      await openInEditor(code.root, code.editor, line === undefined ? { path: requiredString(body, 'path') } : { path: requiredString(body, 'path'), line });
      return { status: NO_CONTENT };
    }),
    route('GET', /^\/api\/note-files\/missing$/, async () => ({
      status: OK,
      body: { missing: code === undefined ? [] : await missingFiles(code.root, (await store.read()).notes), openable: code !== undefined && code.editor !== null },
    })),
    route('GET', /^\/api\/jira$/, async () => ({ status: OK, body: jira?.health() ?? JIRA_OFF })),
    // outside history: statuses from Jira are not the user's change to take back
    route('POST', /^\/api\/jira\/refresh$/, async () => {
      const [health] = await Promise.all([jira === undefined ? JIRA_OFF : jira.refresh(), mergeRequests?.()]);
      return { status: OK, body: health };
    }),
    route('POST', /^\/api\/undo$/, async () => historyAnswer(await history.undo(store), 'Нельзя отменить: эти данные изменились после этого')),
    route('POST', /^\/api\/redo$/, async () => historyAnswer(await history.redo(store), 'Нельзя повторить: эти данные изменились после отмены')),
  ];
}

function historyAnswer(result: HistoryResult, conflict: string): RouteResult {
  if (result === 'conflict') throw new HttpError(CONFLICT, conflict);
  return { status: OK, body: { applied: result === 'applied' } };
}

/** ~/Projects/app instead of /Users/me/Projects/app */
function homeShortened(folder: string): string {
  const home = homedir();
  return folder === home || folder.startsWith(`${home}/`) ? `~${folder.slice(home.length)}` : folder;
}

function route(method: string, pattern: RegExp, handler: (ctx: RouteContext) => Promise<RouteResult>): Route {
  return { method, pattern, handler };
}

async function readObject(ctx: RouteContext): Promise<Params> {
  const body = await ctx.readBody();
  if (body === undefined) return {};
  if (!isRecord(body)) throw new ValidationError('Тело запроса должно быть JSON-объектом');
  return Object.fromEntries(Object.entries(body));
}

function wrongType(key: string, expected: string): ValidationError {
  return new ValidationError(`Поле ${key}: ожидается ${expected}`);
}

function requiredString(body: Params, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') throw wrongType(key, 'строка');
  return value;
}

function optionalString(body: Params, key: string): string | undefined {
  return body[key] === undefined ? undefined : requiredString(body, key);
}

function nullableString(body: Params, key: string): string | null | undefined {
  return body[key] === null ? null : optionalString(body, key);
}

function optionalStringArray(body: Params, key: string): string[] | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw wrongType(key, 'массив строк');
  return value.map(item => {
    if (typeof item !== 'string') throw wrongType(key, 'массив строк');
    return item;
  });
}

function requiredInteger(body: Params, key: string): number {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) throw wrongType(key, 'целое число');
  return value;
}

function optionalInteger(body: Params, key: string): number | undefined {
  return body[key] === undefined ? undefined : requiredInteger(body, key);
}

function optionalBoolean(body: Params, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw wrongType(key, 'true или false');
  return value;
}

function requiredOneOf<T extends string>(body: Params, key: string, values: readonly T[], noun: string): T {
  return oneOfValue(requiredString(body, key), key, values, noun);
}

function oneOfValue<T extends string>(value: string, key: string, values: readonly T[], noun: string): T {
  const found = values.find(v => v === value);
  if (found === undefined) throw new ValidationError(`Поле ${key}: ${noun} ${value}`);
  return found;
}

function optionalOneOf<T extends string>(body: Params, key: string, values: readonly T[], noun: string): T | undefined {
  return body[key] === undefined ? undefined : requiredOneOf(body, key, values, noun);
}

function requiredDescription(body: Params): string | null {
  const value = nullableString(body, 'description');
  if (value === undefined) throw wrongType('description', 'строка или null');
  return value;
}

function notePatch(body: Params): NotePatch {
  return {
    title: optionalString(body, 'title'),
    body: optionalString(body, 'body'),
    directionIds: optionalStringArray(body, 'directionIds'),
    files: optionalList(body, 'files', 'список {path, line?}', isNoteFile),
    urls: optionalList(body, 'urls', 'список {url, title?}', isNoteUrl),
  };
}

function optionalList<T>(body: Params, key: string, expected: string, guard: (v: unknown) => v is T): T[] | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(guard)) throw wrongType(key, expected);
  return value;
}

function requiredQuery(ctx: RouteContext, key: string): string {
  const value = ctx.query.get(key);
  if (value === null) throw new ValidationError(`Параметр ${key} обязателен`);
  return value;
}

function agentOf(body: Record<string, unknown>): { agent?: Agent } {
  const name = optionalString(body, 'agent');
  return name === undefined ? {} : { agent: oneOfValue(name, 'agent', AGENTS, 'неизвестный агент') };
}
