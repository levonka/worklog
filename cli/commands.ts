import { parseArgs } from 'node:util';
import type { Direction, EventSource, LinkKind, Note, NoteFile, NoteUrl, Profile, RepeatRule, Status, Todo, WorklogState } from '../shared/model.ts';
import {
  activeRuns,
  BOARD_STATUSES,
  LINK_KINDS,
  STATUS_ALIASES,
  STATUS_LABELS,
  activeDraft,
  compareText,
  currentPeriodStart,
  directionStage,
  fileLabel,
  isJiraLed,
  localDate,
  localStamp,
  markOf,
  noteLinkLines,
  noteMatches,
  parseNoteLink,
  parseRepeatDays,
  periodDigest,
  profileQuickLinks,
  repeatLabel,
  statusFromAlias,
  templateText,
  withScheme,
} from '../shared/model.ts';
import { missingFiles } from '../server/code-files.ts';
import { commitData, initDataRepo } from '../server/data-git.ts';
import { fetchProfile } from '../server/profile-source.ts';
import type { MatchedTab } from '../server/chrome-tabs.ts';
import { matchTabs, readChromeTabs } from '../server/chrome-tabs.ts';
import { resolveDirection } from '../server/resolve.ts';
import { isErrorCode } from '../server/fs-utils.ts';
import { NotFoundError, Store } from '../server/store.ts';
import { SETUP_USAGES } from './setup.ts';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Env {
  dataDir: string;
  chromeDir?: string;
  /** the repository note file paths are relative to */
  codeRoot?: string;
  profile?: Profile | null;
  envFile?: string;
  profilePath?: string;
  profileSource?: string;
  gitlabUser?: string;
}

type Handler = (args: string[], store: Store, env: Env) => Promise<string>;

const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const RECENT_EVENTS = 10;
const CLI_SOURCES = ['manual', 'claude'] as const satisfies readonly EventSource[];
const SEPARATOR = ' · ';

const USAGES = {
  state: 'state [--json]',
  'dir add': 'dir add <title> [--status S] [--ticket KEY]... [--waiting WHO]',
  'dir show': 'dir show <ref> [--json]',
  'dir status': 'dir status <ref> <status> [--waiting WHO]',
  'dir unmark': 'dir unmark <ref>',
  'dir done-at': 'dir done-at <ref> <YYYY-MM-DD>',
  'dir rename': 'dir rename <ref> <title>',
  'dir rm': 'dir rm <ref>',
  event: 'event <ref> <text> [--source manual|claude]',
  'ticket add': 'ticket add <ref> <KEY>',
  'ticket rm': 'ticket rm <ref> <KEY>',
  'link add': 'link add <ref> <url> [--title T] [--kind K] [--desc TEXT]',
  'link desc': 'link desc <ref> <url> <text>',
  'link rm': 'link rm <ref> <url>',
  'todo add': 'todo add <text> [--dir REF] [--from WHO] [--due YYYY-MM-DD] [--time HH:MM] [--link URL]',
  'todo edit': 'todo edit <id> [--time HH:MM | --no-time] [--link URL | --no-link]',
  'todo done': 'todo done <id>',
  'todo undo': 'todo undo <id>',
  'todo list': 'todo list [--json]',
  'repeat add': 'repeat add <text> --every day|weekdays|mon,…,sun [--dir REF] [--from WHO] [--time HH:MM] [--link URL]',
  'repeat edit': 'repeat edit <id> [--time HH:MM | --no-time] [--link URL | --no-link]',
  'repeat list': 'repeat list [--json]',
  'repeat rm': 'repeat rm <id>',
  'quicklink add': 'quicklink add <groupTitle> <title> <url> [--desc TEXT]',
  'quicklink desc': 'quicklink desc <groupTitle> <url> <text>',
  'quicklink rm': 'quicklink rm <groupTitle> <url>',
  'quicklink group-rm': 'quicklink group-rm <groupTitle>',
  'quicklink import': 'quicklink import',
  'daily show': 'daily show [--json]',
  tabs: 'tabs [--json]',
  'note add': 'note add <title> [--body TEXT] [--dir REF]... [--link PATH[:LINE]|URL [TITLE]]...',
  'note edit': 'note edit <note> [--title T] [--body TEXT] [--dir REF]... [--link L]... [--no-dirs] [--no-links]',
  'note show': 'note show <note> [--json]',
  'note list': 'note list [--dir REF] [--search Q] [--json]',
  'note rm': 'note rm <note>',
  'note check': 'note check',
  'agent list': 'agent list [--json]',
  'agent done': 'agent done <id>',
  'profile fetch': 'profile fetch <source> [--from FILE]',
  'profile update': 'profile update',
  'data init': 'data init',
  'data commit': 'data commit [--message T]',
} as const;

type CommandName = keyof typeof USAGES;

const USAGE = `Использование:
${[...Object.values(USAGES), ...Object.values(SETUP_USAGES)]
  .map(usage => `  worklog ${usage}`)
  .join('\n')}
Статусы: ${Object.keys(STATUS_ALIASES).join(', ')}`;

const DASH_HINT = 'Текст, начинающийся с «-», передайте после --: worklog event <ref> -- "-5 багов"';

class UsageError extends Error {}

const COMMANDS: Record<string, Record<string, Handler> | Handler> = {
  state: stateCommand,
  dir: { add: dirAdd, show: dirShow, status: dirStatus, unmark: dirUnmark, 'done-at': dirDoneAt, rename: dirRename, rm: dirRm },
  event: eventCommand,
  ticket: { add: ticketAdd, rm: ticketRm },
  link: { add: linkAdd, desc: linkDesc, rm: linkRm },
  todo: { add: todoAdd, edit: todoEdit, done: todoDone, undo: todoUndo, list: todoList },
  repeat: { add: repeatAdd, edit: repeatEdit, list: repeatList, rm: repeatRm },
  quicklink: { add: quicklinkAdd, desc: quicklinkDesc, rm: quicklinkRm, 'group-rm': quicklinkGroupRm, import: quicklinkImport },
  note: { add: noteAdd, edit: noteEdit, show: noteShow, list: noteList, rm: noteRm, check: noteCheck },
  daily: { show: dailyShow },
  tabs: tabsCommand,
  agent: { list: agentList, done: agentDone },
  profile: { fetch: profileFetch, update: profileUpdate },
  data: { init: dataInit, commit: dataCommit },
};

export async function runCli(argv: string[], env: Env): Promise<CliResult> {
  try {
    const [command, ...rest] = argv;
    const entry = command === undefined ? undefined : Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
    if (entry === undefined) throw new UsageError(command === undefined ? 'Не указана команда' : `Неизвестная команда: ${command}`);

    let handler: Handler;
    let args: string[];
    if (typeof entry === 'function') {
      handler = entry;
      args = rest;
    } else {
      const [sub, ...subRest] = rest;
      const found = sub === undefined || !Object.hasOwn(entry, sub) ? undefined : entry[sub];
      if (found === undefined) throw new UsageError(`Неизвестная подкоманда: ${command} ${sub ?? ''}`.trimEnd());
      handler = found;
      args = subRest;
    }

    const stdout = await handler(args, new Store(env.dataDir, { profile: env.profile ?? null }), env);
    return { code: 0, stdout: stdout === '' ? '' : `${stdout}\n`, stderr: '' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UsageError) return { code: EXIT_USAGE, stdout: '', stderr: `${message}\n${USAGE}\n` };
    if (isErrorCode(error, 'ERR_PARSE_ARGS_UNKNOWN_OPTION')) return { code: EXIT_ERROR, stdout: '', stderr: `${message}\n${DASH_HINT}\n` };
    return { code: EXIT_ERROR, stdout: '', stderr: `${message}\n` };
  }
}

function positionalsOf(positionals: string[], command: CommandName): string[] {
  const usage = USAGES[command];
  const count = (usage.replace(/\[[^\]]*\]/g, '').match(/<[^>]+>/g) ?? []).length;
  if (positionals.length !== count) throw new Error(`Использование: worklog ${usage}`);
  return positionals;
}

async function directionFor(store: Store, ref: string): Promise<Direction> {
  return resolveDirection((await store.read()).directions, ref);
}

function parseStatus(raw: string): Status {
  const status = statusFromAlias(raw);
  if (!status) throw new Error(`Неизвестный статус: ${raw}. Допустимо: ${Object.keys(STATUS_ALIASES).join(', ')}`);
  return status;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function formatAt(iso: string): string {
  const d = new Date(iso);
  return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openTodos(state: WorklogState, directionId: string): Todo[] {
  return state.todos.filter(t => !t.done && t.directionId === directionId);
}

function byOrder(directions: Direction[], status: Direction['status']): Direction[] {
  return directions.filter(d => d.status === status).sort((a, b) => a.order - b.order);
}

function stateLine(direction: Direction, state: WorklogState): string {
  const parts = [direction.title];
  if (direction.tickets.length > 0) parts.push(direction.tickets.map(t => t.key).join(' '));
  if (direction.waitingFor) parts.push(`жду: ${direction.waitingFor}`);
  if (markOf(direction.status) !== null) parts.push(`этап: ${STATUS_LABELS[directionStage(direction)]}`);
  const todos = openTodos(state, direction.id).length;
  if (todos > 0) parts.push(`дел: ${todos}`);
  return `  ${parts.join(SEPARATOR)}`;
}

function todoLine(todo: Todo, state: WorklogState): string {
  const direction = state.directions.find(d => d.id === todo.directionId);
  const parts = [todo.text];
  if (direction) parts.push(direction.title);
  if (todo.requestedBy) parts.push(`от ${todo.requestedBy}`);
  if (todo.due) parts.push(`до ${todo.due}`);
  if (todo.time) parts.push(`в ${todo.time}`);
  const rule = state.repeats.find(r => r.id === todo.repeatId);
  if (rule) parts.push(`↻ ${repeatLabel(rule.days)}`);
  if (todo.url) parts.push(todo.url);
  return parts.join(SEPARATOR);
}

const LINK_TIME_OPTIONS = {
  time: { type: 'string' },
  'no-time': { type: 'boolean' },
  link: { type: 'string' },
  'no-link': { type: 'boolean' },
} as const;

/** `--x VALUE` sets, `--no-x` removes, neither leaves it as it is */
function linkTimePatch(values: { time?: string; 'no-time'?: boolean; link?: string; 'no-link'?: boolean }, command: CommandName): { url?: string | null; time?: string | null } {
  if ((values.time !== undefined && values['no-time']) || (values.link !== undefined && values['no-link'])) {
    throw new Error(`Нельзя одновременно задать и убрать одно поле. Использование: worklog ${USAGES[command]}`);
  }
  const patch: { url?: string | null; time?: string | null } = {};
  if (values.time !== undefined) patch.time = values.time;
  if (values['no-time']) patch.time = null;
  if (values.link !== undefined) patch.url = values.link;
  if (values['no-link']) patch.url = null;
  if (Object.keys(patch).length === 0) throw new Error(`Нечего менять. Использование: worklog ${USAGES[command]}`);
  return patch;
}

async function stateCommand(args: string[], store: Store): Promise<string> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } }, strict: true });
  await store.applyRepeats();
  const state = await store.read();
  if (values.json) return json(state);

  const lines: string[] = [];
  for (const status of BOARD_STATUSES) {
    const column = byOrder(state.directions, status);
    if (column.length === 0) continue;
    lines.push(`● ${STATUS_LABELS[status]} (${column.length})`, ...column.map(d => stateLine(d, state)));
  }
  const parked = byOrder(state.directions, 'parked');
  if (parked.length > 0) lines.push(`${STATUS_LABELS.parked} (${parked.length})`, ...parked.map(d => stateLine(d, state)));
  const todos = state.todos.filter(t => !t.done);
  if (todos.length > 0) lines.push(`Дела (${todos.length})`, ...todos.map(t => `  ${t.id}  ${todoLine(t, state)}`));
  return lines.length > 0 ? lines.join('\n') : 'Направлений и дел нет';
}

async function dirAdd(args: string[], store: Store): Promise<string> {
  const { values, positionals } = parseArgs({
    args,
    options: { status: { type: 'string' }, ticket: { type: 'string', multiple: true }, waiting: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  const [title] = positionalsOf(positionals, 'dir add');
  const status = values.status === undefined ? undefined : parseStatus(values.status);
  const direction = await store.createDirection({ title, status, ticketKeys: values.ticket, waitingFor: values.waiting });
  return direction.id;
}

async function dirShow(args: string[], store: Store): Promise<string> {
  const { values, positionals } = parseArgs({ args, options: { json: { type: 'boolean' } }, allowPositionals: true, strict: true });
  const [ref] = positionalsOf(positionals, 'dir show');
  const state = await store.read();
  const direction = resolveDirection(state.directions, ref);
  const todos = state.todos.filter(t => t.directionId === direction.id);
  if (values.json) return json({ direction, todos, notes: state.notes.filter(n => n.directionIds.includes(direction.id)) });

  const status = direction.waitingFor ? `${STATUS_LABELS[direction.status]}${SEPARATOR}${direction.waitingFor}` : STATUS_LABELS[direction.status];
  const stage = `${STATUS_LABELS[directionStage(direction)]} (${isJiraLed(direction) ? 'Jira' : 'вручную'})`;
  const lines = [direction.title, `id: ${direction.id}`, `Статус: ${status}`, `Этап: ${stage}`];
  if (direction.tickets.length > 0) lines.push('Тикеты:', ...direction.tickets.map(t => `  ${t.key}${SEPARATOR}${t.url}`));
  if (direction.links.length > 0) {
    lines.push('Ссылки:');
    for (const l of direction.links) {
      lines.push(`  ${l.title}${SEPARATOR}${l.url}${SEPARATOR}${l.kind}`);
      if (l.description !== undefined) lines.push(...l.description.split('\n').map(line => `    ${line}`));
    }
  }
  const notes = state.notes.filter(n => n.directionIds.includes(direction.id));
  if (notes.length > 0) lines.push('Заметки (note show <id>):', ...notes.map(n => `  ${n.id}  ${n.title}`));
  if (todos.length > 0) lines.push('Дела:', ...todos.map(t => `  [${t.done ? 'x' : ' '}] ${t.id}  ${todoLine(t, state)}`));
  const events = direction.events.slice(-RECENT_EVENTS);
  if (events.length > 0) lines.push(`События (последние ${RECENT_EVENTS}):`, ...events.map(e => `  ${formatAt(e.at)}${SEPARATOR}${e.text}${SEPARATOR}${e.source}`));
  return lines.join('\n');
}

async function dirStatus(args: string[], store: Store): Promise<string> {
  const { values, positionals } = parseArgs({ args, options: { waiting: { type: 'string' } }, allowPositionals: true, strict: true });
  const [ref, rawStatus] = positionalsOf(positionals, 'dir status');
  const status = parseStatus(rawStatus);
  const direction = await directionFor(store, ref);
  const updated = await store.setStatus(direction.id, status, values.waiting === undefined ? {} : { waitingFor: values.waiting });
  return `${updated.title}: ${STATUS_LABELS[updated.status]}`;
}

async function dirUnmark(args: string[], store: Store): Promise<string> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  const [ref] = positionalsOf(positionals, 'dir unmark');
  const updated = await store.clearMark((await directionFor(store, ref)).id);
  return `${updated.title}: ${STATUS_LABELS[updated.status]}`;
}

// only done directions take a done date, so they win over active ones with a similar name
async function doneDirectionFor(store: Store, ref: string): Promise<Direction> {
  const { directions } = await store.read();
  try {
    return resolveDirection(directions.filter(d => d.status === 'done'), ref);
  } catch (error) {
    if (error instanceof NotFoundError) return resolveDirection(directions, ref);
    throw error;
  }
}

async function dirDoneAt(args: string[], store: Store): Promise<string> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  const [ref, day] = positionalsOf(positionals, 'dir done-at');
  const direction = await doneDirectionFor(store, ref);
  const updated = await store.setDoneDate(direction.id, day);
  return `${updated.title}: сделано ${day}`;
}

async function dirRename(args: string[], store: Store): Promise<string> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  const [ref, title] = positionalsOf(positionals, 'dir rename');
  const direction = await directionFor(store, ref);
  const renamed = await store.renameDirection(direction.id, title);
  return renamed.title;
}

async function dirRm(args: string[], store: Store): Promise<string> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  const [ref] = positionalsOf(positionals, 'dir rm');
  const direction = await directionFor(store, ref);
  await store.deleteDirection(direction.id);
  return `Удалено: ${direction.title}`;
}

async function eventCommand(args: string[], store: Store): Promise<string> {
  const { values, positionals } = parseArgs({ args, options: { source: { type: 'string' } }, allowPositionals: true, strict: true });
  const [ref, text] = positionalsOf(positionals, 'event');
  const source = CLI_SOURCES.find(s => s === (values.source ?? 'claude'));
  if (!source) throw new Error(`Источник должен быть один из: ${CLI_SOURCES.join(', ')}`);
  const direction = await directionFor(store, ref);
  await store.addEvent(direction.id, text, source);
  return `Событие записано: ${direction.title}`;
}

async function ticketAdd(args: string[], store: Store): Promise<string> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  const [ref, key] = positionalsOf(positionals, 'ticket add');
  const direction = await directionFor(store, ref);
  const ticket = await store.addTicket(direction.id, key);
  return `${ticket.key}: ${direction.title}`;
}

async function ticketRm(args: string[], store: Store): Promise<string> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  const [ref, key] = positionalsOf(positionals, 'ticket rm');
  const direction = await directionFor(store, ref);
  await store.removeTicket(direction.id, key);
  return `Убран ${key}: ${direction.title}`;
}

function parseLinkKind(raw: string | undefined): LinkKind | undefined {
  if (raw === undefined) return undefined;
  const kind = LINK_KINDS.find(k => k === raw);
  if (!kind) throw new Error(`Неизвестный вид ссылки: ${raw}. Допустимо: ${LINK_KINDS.join(', ')}`);
  return kind;
}

async function linkAdd(args: string[], store: Store): Promise<string> {
  const { values, positionals } = parseArgs({
    args,
    options: { title: { type: 'string' }, kind: { type: 'string' }, desc: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  const [ref, url] = positionalsOf(positionals, 'link add');
  const kind = parseLinkKind(values.kind);
  const direction = await directionFor(store, ref);
  const link = await store.addLink(direction.id, { url, title: values.title, kind, description: values.desc });
  return `${link.title}${SEPARATOR}${link.kind}`;
}

async function linkDesc(args: string[], store: Store): Promise<string> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  const [ref, url, text] = positionalsOf(positionals, 'link desc');
  const direction = await directionFor(store, ref);
  const link = await store.setLinkDescription(direction.id, withScheme(url.trim()), text);
  return link.description === undefined ? `Описание убрано: ${link.title}` : `Описание: ${link.title}`;
}

async function linkRm(args: string[], store: Store): Promise<string> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  const [ref, url] = positionalsOf(positionals, 'link rm');
  const direction = await directionFor(store, ref);
  await store.removeLink(direction.id, url);
  return `Ссылка убрана: ${direction.title}`;
}

async function todoAdd(args: string[], store: Store): Promise<string> {
  const { values, positionals } = parseArgs({
    args,
    options: { dir: { type: 'string' }, from: { type: 'string' }, due: { type: 'string' }, time: { type: 'string' }, link: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  const [text] = positionalsOf(positionals, 'todo add');
  const directionId = values.dir === undefined ? undefined : (await directionFor(store, values.dir)).id;
  const todo = await store.addTodo({ text, directionId, requestedBy: values.from, due: values.due, time: values.time, url: values.link });
  return todo.id;
}

async function todoEdit(args: string[], store: Store): Promise<string> {
  const { values, positionals } = parseArgs({ args, options: LINK_TIME_OPTIONS, allowPositionals: true, strict: true });
  const [id] = positionalsOf(positionals, 'todo edit');
  const todo = await store.updateTodo(id, linkTimePatch(values, 'todo edit'));
  return `Изменено: ${todoLine(todo, await store.read())}`;
}

async function todoDone(args: string[], store: Store): Promise<string> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  const [id] = positionalsOf(positionals, 'todo done');
  const todo = await store.setTodoDone(id, true);
  return `Готово: ${todo.text}`;
}

async function todoUndo(args: string[], store: Store): Promise<string> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  const [id] = positionalsOf(positionals, 'todo undo');
  const todo = await store.setTodoDone(id, false);
  return `Снова открыто: ${todo.text}`;
}

async function todoList(args: string[], store: Store): Promise<string> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } }, strict: true });
  await store.applyRepeats();
  const state = await store.read();
  if (values.json) return json(state.todos);
  if (state.todos.length === 0) return 'Дел нет';
  return state.todos.map(t => `[${t.done ? 'x' : ' '}] ${t.id}  ${todoLine(t, state)}`).join('\n');
}

async function repeatAdd(args: string[], store: Store): Promise<string> {
  const { values, positionals } = parseArgs({
    args,
    options: { every: { type: 'string' }, dir: { type: 'string' }, from: { type: 'string' }, time: { type: 'string' }, link: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  const [text] = positionalsOf(positionals, 'repeat add');
  if (values.every === undefined) throw new Error(`Не указано --every. Использование: worklog ${USAGES['repeat add']}`);
  const days = parseRepeatDays(values.every);
  if (days === null) throw new Error(`Не понял дни: ${values.every}. Допустимо: day, weekdays или дни через запятую: mon,tue,wed,thu,fri,sat,sun`);
  const directionId = values.dir === undefined ? undefined : (await directionFor(store, values.dir)).id;
  const rule = await store.addRepeat({ text, days, directionId, requestedBy: values.from, time: values.time, url: values.link });
  const made = (await store.applyRepeats()) > 0;
  return `${rule.id}  ${rule.text} · ${repeatLabel(rule.days)}${made ? ' · дело на сегодня добавлено' : ''}`;
}

async function repeatEdit(args: string[], store: Store): Promise<string> {
  const { values, positionals } = parseArgs({ args, options: LINK_TIME_OPTIONS, allowPositionals: true, strict: true });
  const [id] = positionalsOf(positionals, 'repeat edit');
  const rule = await store.updateRepeat(id, linkTimePatch(values, 'repeat edit'));
  return `Изменено: ${repeatLine(rule, await store.read())}`;
}

async function repeatList(args: string[], store: Store): Promise<string> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } }, strict: true });
  const state = await store.read();
  if (values.json) return json(state.repeats);
  if (state.repeats.length === 0) return 'Повторяющихся дел нет';
  return state.repeats.map(rule => `${rule.id}  ${repeatLine(rule, state)}`).join('\n');
}

function repeatLine(rule: RepeatRule, state: WorklogState): string {
  const direction = state.directions.find(d => d.id === rule.directionId);
  const parts = [rule.text, repeatLabel(rule.days)];
  if (direction) parts.push(direction.title);
  if (rule.requestedBy) parts.push(`от ${rule.requestedBy}`);
  if (rule.time) parts.push(`в ${rule.time}`);
  if (rule.url) parts.push(rule.url);
  return parts.join(SEPARATOR);
}

async function repeatRm(args: string[], store: Store): Promise<string> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  const [id] = positionalsOf(positionals, 'repeat rm');
  const rule = await store.removeRepeat(id);
  return `Повтор убран: ${rule.text}`;
}

async function agentList(args: string[], store: Store): Promise<string> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } }, strict: true });
  const runs = activeRuns((await store.read()).runs);
  if (values.json) return json(runs);
  if (runs.length === 0) return 'Агенты не работают';
  return runs.map(run => `${run.id}  ${run.title}${SEPARATOR}${run.branch}${SEPARATOR}с ${formatAt(run.startedAt)}`).join('\n');
}

async function agentDone(args: string[], store: Store): Promise<string> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  const [id] = positionalsOf(positionals, 'agent done');
  const run = await store.finishRun(id);
  return `Отметка снята: ${run.title}`;
}

async function quicklinkAdd(args: string[], store: Store): Promise<string> {
  const { values, positionals } = parseArgs({ args, options: { desc: { type: 'string' } }, allowPositionals: true, strict: true });
  const [groupTitle, title, url] = positionalsOf(positionals, 'quicklink add');
  const existing = findGroup(await store.read(), groupTitle);
  const group = await store.addQuickLink(existing?.title ?? groupTitle, { title, url, description: values.desc });
  return `${title}: ${group.title}`;
}

async function quicklinkDesc(args: string[], store: Store): Promise<string> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  const [groupTitle, url, text] = positionalsOf(positionals, 'quicklink desc');
  const group = findGroup(await store.read(), groupTitle);
  if (!group) throw new Error(`Группа ссылок не найдена: ${groupTitle}`);
  const link = await store.setQuickLinkDescription(group.id, withScheme(url.trim()), text);
  return link.description === undefined ? `Описание убрано: ${link.title}` : `Описание: ${link.title}`;
}

async function quicklinkRm(args: string[], store: Store): Promise<string> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  const [groupTitle, url] = positionalsOf(positionals, 'quicklink rm');
  const group = findGroup(await store.read(), groupTitle);
  if (!group) throw new Error(`Группа ссылок не найдена: ${groupTitle}`);
  await store.removeQuickLink(group.id, url);
  return `Ссылка убрана: ${group.title}`;
}

async function quicklinkGroupRm(args: string[], store: Store): Promise<string> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  const [groupTitle] = positionalsOf(positionals, 'quicklink group-rm');
  const group = findGroup(await store.read(), groupTitle);
  if (!group) throw new Error(`Группа ссылок не найдена: ${groupTitle}`);
  await store.removeQuickLinkGroup(group.id);
  return `Группа удалена: ${group.title}`;
}

async function quicklinkImport(args: string[], store: Store, env: Env): Promise<string> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  positionalsOf(positionals, 'quicklink import');
  if (!env.profile) throw new Error('Нет профиля компании: worklog profile fetch <ссылка>');
  const { groups, skipped } = profileQuickLinks(env.profile, env.gitlabUser);
  const { added, present } = await store.importQuickLinks(groups);
  const lines = [`Ссылки из профиля: добавлено ${added}, уже были ${present}`];
  if (skipped.length > 0) lines.push(`Пропущены (нет WORKLOG_GITLAB_USER): ${skipped.join(', ')}`);
  return lines.join('\n');
}

function settingsPaths(env: Env): { envFile: string; profilePath: string } {
  if (env.envFile === undefined || env.profilePath === undefined) throw new Error('Не заданы пути файла настроек и профиля');
  return { envFile: env.envFile, profilePath: env.profilePath };
}

async function saveProfile(source: string, env: Env, from: string | undefined): Promise<string> {
  const paths = settingsPaths(env);
  const profile = await fetchProfile(source, { ...paths, from, gitlab: env.profile?.gitlab, codeRoot: env.codeRoot });
  return `Профиль сохранён: ${paths.profilePath}, версия ${profile.version}. Перезапусти сервер, если он работает.`;
}

async function profileFetch(args: string[], _store: Store, env: Env): Promise<string> {
  const { values, positionals } = parseArgs({ args, options: { from: { type: 'string' } }, allowPositionals: true, strict: true });
  const [source] = positionalsOf(positionals, 'profile fetch');
  return saveProfile(source, env, values.from);
}

async function profileUpdate(args: string[], _store: Store, env: Env): Promise<string> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  positionalsOf(positionals, 'profile update');
  if (env.profileSource === undefined) throw new Error('Источник профиля не записан: worklog profile fetch <ссылка или полный путь>');
  return saveProfile(env.profileSource, env, undefined);
}

async function dataInit(args: string[], _store: Store, env: Env): Promise<string> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  positionalsOf(positionals, 'data init');
  return (await initDataRepo(env.dataDir)) === 'created' ? `Свой git данных заведён: ${env.dataDir}` : `Свой git данных уже есть: ${env.dataDir}`;
}

async function dataCommit(args: string[], _store: Store, env: Env): Promise<string> {
  const { values, positionals } = parseArgs({ args, options: { message: { type: 'string' } }, allowPositionals: true, strict: true });
  positionalsOf(positionals, 'data commit');
  const hash = await commitData(env.dataDir, values.message ?? `Снимок данных ${localStamp(new Date().toISOString())}`);
  return hash === null ? 'Нечего коммитить: данные не менялись' : `Данные закоммичены: ${hash}`;
}

async function dailyShow(args: string[], store: Store): Promise<string> {
  const { values, positionals } = parseArgs({ args, options: { json: { type: 'boolean' } }, allowPositionals: true, strict: true });
  positionalsOf(positionals, 'daily show');
  const state = await store.read();
  const now = new Date();
  const periodStart = currentPeriodStart(now, state.dailies);
  const draft = activeDraft(state, periodStart);
  const digest = periodDigest(state, periodStart, draft?.summary ?? null, localDate(now));
  const text = draft?.text ?? templateText(digest);
  const waiting = digest.waiting.map(w => ({ title: w.direction.title, waitingFor: w.direction.waitingFor ?? null, since: w.since }));
  if (values.json) return json({ periodStart, text, waiting });
  const lines = [`Дейлик · период с ${localStamp(periodStart)}`, '', text];
  if (waiting.length > 0) lines.push('', ...waiting.map(w => `Жду: ${w.title}${w.waitingFor ? ` — ${w.waitingFor}` : ''}`));
  return lines.join('\n');
}

async function tabsCommand(args: string[], store: Store, env: Env): Promise<string> {
  const { values, positionals } = parseArgs({ args, options: { json: { type: 'boolean' } }, allowPositionals: true, strict: true });
  positionalsOf(positionals, 'tabs');
  if (env.chromeDir === undefined) throw new Error('Не задана папка Chrome');
  const [chromeTabs, state] = await Promise.all([readChromeTabs(env.chromeDir), store.read()]);
  const tabs = matchTabs(chromeTabs, state);
  if (values.json) return json(tabs);

  const tabLines = (tab: MatchedTab, withKeys: boolean) => [
    `  ${withKeys ? `${tab.keys.join(' ')}${SEPARATOR}` : ''}${tab.title || '(без заголовка)'}`,
    `    ${tab.url}${tab.saved ? `${SEPARATOR}сохранена` : ''}`,
  ];
  const lines = [`Вкладок: ${tabs.length}`];
  const byDirection = new Map<string, { title: string; tabs: MatchedTab[] }>();
  for (const tab of tabs) {
    for (const direction of tab.directions) {
      const group = byDirection.get(direction.id) ?? { title: direction.title, tabs: [] };
      group.tabs.push(tab);
      byDirection.set(direction.id, group);
    }
  }
  for (const [id, group] of byDirection) lines.push('', `${group.title}${SEPARATOR}${id}`, ...group.tabs.flatMap(t => tabLines(t, false)));
  const unknownKeys = tabs.filter(t => t.keys.length > 0 && t.directions.length === 0);
  if (unknownKeys.length > 0) lines.push('', 'Номера без направления', ...unknownKeys.flatMap(t => tabLines(t, true)));
  const noKeys = tabs.filter(t => t.keys.length === 0 && t.directions.length === 0);
  if (noKeys.length > 0) lines.push('', 'Без номеров', ...noKeys.flatMap(t => tabLines(t, false)));
  return lines.join('\n');
}

const NOTE_OPTIONS = {
  title: { type: 'string' },
  body: { type: 'string' },
  dir: { type: 'string', multiple: true },
  link: { type: 'string', multiple: true },
  'no-dirs': { type: 'boolean' },
  'no-links': { type: 'boolean' },
  json: { type: 'boolean' },
} as const;

function noteLinks(raw: readonly string[]): { files: NoteFile[]; urls: NoteUrl[] } {
  const files: NoteFile[] = [];
  const urls: NoteUrl[] = [];
  for (const line of raw) {
    const link = parseNoteLink(line);
    if (link === null) throw new Error(`Не понял ссылку: ${line}. Нужен путь от корня проекта (src/x.ts:42) или https://…`);
    if ('file' in link) files.push(link.file);
    else urls.push(link.url);
  }
  return { files, urls };
}

/** an id, or a part of the title that only one note has */
function resolveNote(notes: readonly Note[], ref: string): Note {
  const byId = notes.find(n => n.id === ref);
  if (byId) return byId;
  const needle = ref.trim().toLowerCase();
  const found = notes.filter(n => n.title.toLowerCase().includes(needle));
  if (found.length === 1) return found[0];
  if (found.length === 0) throw new Error(`Заметка не найдена: ${ref}`);
  throw new Error(`Подходят несколько заметок: ${found.map(n => `${n.id} ${n.title}`).join('; ')}`);
}

async function missingFor(env: Env, notes: readonly Note[]): Promise<Set<string>> {
  return new Set(env.codeRoot === undefined ? [] : await missingFiles(env.codeRoot, notes));
}

function noteText(note: Note, state: WorklogState, missing: ReadonlySet<string>): string {
  const lines = [note.title, `id: ${note.id}`];
  const directions = state.directions.filter(d => note.directionIds.includes(d.id));
  if (directions.length > 0) lines.push(`Направления: ${directions.map(d => d.title).join(', ')}`);
  if (note.body !== '') lines.push('', note.body);
  const links = [...note.files.map(f => `${fileLabel(f)}${missing.has(f.path) ? `${SEPARATOR}✗ файла нет` : ''}`), ...noteLinkLines({ files: [], urls: note.urls })];
  if (links.length > 0) lines.push('', 'Ссылки:', ...links.map(l => `  ${l}`));
  return lines.join('\n');
}

function noteLine(note: Note, missing: ReadonlySet<string>): string {
  const broken = note.files.filter(f => missing.has(f.path)).length;
  return `${note.id}  ${note.title}${broken > 0 ? `${SEPARATOR}битых ссылок: ${broken}` : ''}`;
}

async function noteAdd(args: string[], store: Store): Promise<string> {
  const { values, positionals } = parseArgs({ args, options: NOTE_OPTIONS, allowPositionals: true, strict: true });
  const [title] = positionalsOf(positionals, 'note add');
  const state = await store.read();
  const directionIds = (values.dir ?? []).map(ref => resolveDirection(state.directions, ref).id);
  const note = await store.createNote({ title, body: values.body, directionIds, ...noteLinks(values.link ?? []) });
  return note.id;
}

async function noteEdit(args: string[], store: Store): Promise<string> {
  const { values, positionals } = parseArgs({ args, options: NOTE_OPTIONS, allowPositionals: true, strict: true });
  const [ref] = positionalsOf(positionals, 'note edit');
  const state = await store.read();
  const note = resolveNote(state.notes, ref);
  const directionIds = values['no-dirs'] ? [] : values.dir?.map(r => resolveDirection(state.directions, r).id);
  const links = values['no-links'] ? { files: [], urls: [] } : values.link === undefined ? {} : noteLinks(values.link);
  const updated = await store.updateNote(note.id, { title: values.title, body: values.body, directionIds, ...links });
  return `Заметка: ${updated.title}`;
}

async function noteShow(args: string[], store: Store, env: Env): Promise<string> {
  const { values, positionals } = parseArgs({ args, options: { json: { type: 'boolean' } }, allowPositionals: true, strict: true });
  const [ref] = positionalsOf(positionals, 'note show');
  const state = await store.read();
  const note = resolveNote(state.notes, ref);
  const missing = await missingFor(env, [note]);
  if (values.json) return json({ note, missingFiles: [...missing] });
  return noteText(note, state, missing);
}

async function noteList(args: string[], store: Store, env: Env): Promise<string> {
  const { values } = parseArgs({ args, options: { dir: { type: 'string' }, search: { type: 'string' }, json: { type: 'boolean' } }, strict: true });
  const state = await store.read();
  const directionId = values.dir === undefined ? undefined : resolveDirection(state.directions, values.dir).id;
  const notes = state.notes
    .filter(n => directionId === undefined || n.directionIds.includes(directionId))
    .filter(n => noteMatches(n, values.search ?? '', state.directions))
    .sort((a, b) => compareText(b.updatedAt, a.updatedAt));
  if (values.json) return json(notes);
  if (notes.length === 0) return 'Заметок нет';
  const missing = await missingFor(env, notes);
  return notes.map(n => noteLine(n, missing)).join('\n');
}

async function noteRm(args: string[], store: Store): Promise<string> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  const [ref] = positionalsOf(positionals, 'note rm');
  const note = resolveNote((await store.read()).notes, ref);
  await store.deleteNote(note.id);
  return `Удалена: ${note.title}`;
}

async function noteCheck(args: string[], store: Store, env: Env): Promise<string> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  positionalsOf(positionals, 'note check');
  if (env.codeRoot === undefined) throw new Error('Не задан корень кода');
  const { notes } = await store.read();
  const missing = await missingFor(env, notes);
  if (missing.size === 0) return 'Все ссылки на файлы живые';
  return notes
    .filter(n => n.files.some(f => missing.has(f.path)))
    .map(n => `${n.id}  ${n.title}\n${n.files.filter(f => missing.has(f.path)).map(f => `  ✗ ${fileLabel(f)}`).join('\n')}`)
    .join('\n');
}

function findGroup(state: WorklogState, title: string) {
  const needle = title.trim().toLowerCase();
  return state.linkGroups.find(g => g.title.toLowerCase() === needle);
}
