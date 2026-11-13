import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import type {
  AgentRequest,
  AgentRun,
  Profile,
  ProfileLinkGroup,
  Daily,
  DailyDraft,
  Direction,
  EventSource,
  Link,
  LinkKind,
  Note,
  NoteFile,
  NoteUrl,
  QuickLink,
  QuickLinkGroup,
  RepeatDay,
  RepeatRule,
  SessionSummary,
  Stage,
  Status,
  SummaryItem,
  SummaryRun,
  Ticket,
  TicketJira,
  Todo,
  TodoCandidate,
  WorkEvent,
  WorklogState,
  Onboarding,
  OnboardingPatch,
} from '../shared/model.ts';
import {
  AGENT_TEMPLATES,
  AGENTS,
  AGENT_TEMPLATE_LABELS,
  AGENT_TEMPLATES_NEEDING_EXTRA,
  DIRECTIONLESS_TEMPLATES,
  DAILY_ITEM_ORIGINS,
  EVENT_KINDS,
  EVENT_SOURCES,
  LINK_KINDS,
  REPEAT_DAYS,
  STAGES,
  STATUSES,
  STATUS_LABELS,
  activeDraft,
  agentContext,
  agentPrompt,
  agentRunTitle,
  clampIndex,
  compareText,
  currentPeriodStart,
  dailyItems,
  detectLinkKind,
  directionBranch,
  directionStage,
  dueRepeats,
  exampleData,
  isExample,
  isBranchName,
  isJiraLed,
  jiraStage,
  isSafeRelativePath,
  localDate,
  markClearedText,
  markOf,
  mergeRequestNumber,
  mergeRequestUrl,
  moveInList,
  normalizeTicketKey,
  parseTime,
  periodDigest,
  placeDirection,
  repeatDayOf,
  stageOf,
  summaryRunState,
  ticketFromKey,
  todoLabel,
  withScheme,
} from '../shared/model.ts';
import { DataError, isErrorCode, readdirIfExists, readJsonFile, withLock, writeJsonAtomic, writeTextAtomic } from './fs-utils.ts';
import type { Guard } from './guards.ts';
import { arrayOf, isLineNumber, isNullableString, isOptionalString, isRecord, isString, isStringArray, oneOf } from './guards.ts';
import { parseNote, serializeNote } from './note-file.ts';

const DIRECTIONS_DIR = 'directions';
const TODOS_FILE = 'todos.json';
const REPEATS_FILE = 'repeats.json';
const LINKS_FILE = 'links.json';
const DAILIES_DIR = 'dailies';
export const DRAFT_FILE = 'daily-draft.json';
const ONBOARDING_FILE = 'onboarding.json';
const JSON_EXT = '.json';
const NOTES_DIR = 'notes';
const NOTE_EXT = '.md';
const RUNS_DIR = 'runs';

export class NotFoundError extends Error {}

export class ValidationError extends Error {}

export class ConflictError extends Error {}

/** One data file around a commit: its compact JSON (a note: its file text) before and after, null when it does not exist */
export interface FileChange {
  file: string;
  before: string | null;
  after: string | null;
}

export type CommitListener = (changes: FileChange[]) => void;

const ID_RANDOM_LENGTH = 4;
const BASE36 = 36;
const DUE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function newId(now: number = Date.now(), random: (max: number) => number = randomInt): string {
  let suffix = '';
  for (let i = 0; i < ID_RANDOM_LENGTH; i++) suffix += random(BASE36).toString(BASE36);
  return now.toString(BASE36) + suffix;
}

/** a ticket as Jira gave it in one poll */
export interface JiraIssue {
  key: string;
  status: string;
  segments: string[];
}

export interface NewDirectionInput {
  title: string;
  status?: Status;
  ticketKeys?: string[];
  waitingFor?: string;
}

export interface NewTodoInput {
  text: string;
  directionId?: string;
  requestedBy?: string;
  due?: string;
  url?: string;
  time?: string;
}

export type SummaryOutcome = { summary: SessionSummary; prose: string | null } | { error: string };

export interface DirectionPatch {
  title?: string;
  waitingFor?: string | null;
}

export interface NoteInput {
  title: string;
  body?: string;
  directionIds?: string[];
  files?: NoteFile[];
  urls?: NoteUrl[];
}

export type NotePatch = Partial<NoteInput>;

export interface NewRepeatInput {
  text: string;
  days: RepeatDay[];
  directionId?: string;
  requestedBy?: string;
  url?: string;
  time?: string;
}

export interface RepeatPatch {
  url?: string | null;
  time?: string | null;
}

export interface TodoPatch {
  done?: boolean;
  text?: string;
  directionId?: string | null;
  requestedBy?: string | null;
  due?: string | null;
  url?: string | null;
  time?: string | null;
}

export interface StoreOptions {
  onCommit?: CommitListener;
  profile?: Profile | null;
}

export class Store {
  private readonly dataDir: string;
  private readonly onCommit: CommitListener | undefined;
  readonly profile: Profile | null;

  constructor(dataDir: string, options: StoreOptions = {}) {
    this.dataDir = dataDir;
    this.onCommit = options.onCommit;
    this.profile = options.profile ?? null;
  }

  read(): Promise<WorklogState> {
    return readState(this.dataDir);
  }

  mutate<T>(fn: (s: WorklogState) => NotPromise<T>): Promise<T> {
    return withLock(this.dataDir, async () => {
      const state = await readState(this.dataDir);
      const before = fileTexts(this.dataDir, state);

      const result = fn(state);
      if (isThenable(result)) {
        // changes made after an await would be lost silently
        Promise.resolve(result).catch(() => undefined);
        throw new Error('mutate: функция изменения должна быть синхронной');
      }
      assertUniqueDirectionIds(state.directions);

      const after = fileTexts(this.dataDir, state);
      const changes: FileChange[] = [];
      for (const [file, text] of after) {
        const old = before.get(file) ?? null;
        if (old !== text) changes.push({ file, before: old, after: text });
      }
      for (const [file, text] of before) {
        if (!after.has(file)) changes.push({ file, before: text, after: null });
      }
      await writeFiles(changes.map(change => ({ file: change.file, text: change.after })));
      if (changes.length > 0) this.onCommit?.(changes);
      return result;
    });
  }

  /** Puts each file back to its `before` (`back`) or `after` (`forward`) text; false and no writes if any file no longer holds the other one */
  restore(changes: readonly FileChange[], direction: 'back' | 'forward'): Promise<boolean> {
    return withLock(this.dataDir, async () => {
      const current = fileTexts(this.dataDir, await readState(this.dataDir));
      const expected = (change: FileChange): string | null => (direction === 'back' ? change.after : change.before);
      if (changes.some(change => (current.get(change.file) ?? null) !== expected(change))) return false;
      await writeFiles(changes.map(change => ({ file: change.file, text: direction === 'back' ? change.before : change.after })));
      return true;
    });
  }

  async createDirection(input: NewDirectionInput): Promise<Direction> {
    const title = requireText(input.title, 'Название');
    const status = input.status ?? 'in_progress';
    const tickets = uniqueTickets((input.ticketKeys ?? []).map(key => parseTicketKey(key, this.profile)));
    const waitingFor = status === 'waiting' ? optionalText(input.waitingFor) : undefined;
    return this.mutate(s => {
      const now = nowIso();
      const direction: Direction = {
        id: newId(),
        title,
        status,
        ...(waitingFor === undefined ? {} : { waitingFor }),
        tickets,
        links: [],
        events: [],
        order: s.directions.filter(d => d.status === status).length,
        stage: stageOf(status) ?? 'in_progress',
        createdAt: now,
        updatedAt: now,
        ...(status === 'done' ? { doneAt: now } : {}),
      };
      s.directions.push(direction);
      return direction;
    });
  }

  async renameDirection(id: string, title: string): Promise<Direction> {
    return this.patchDirection(id, { title });
  }

  async patchDirection(id: string, patch: DirectionPatch): Promise<Direction> {
    const title = patch.title === undefined ? undefined : requireText(patch.title, 'Название');
    return this.mutate(s => {
      const direction = findDirection(s, id);
      if (title === undefined && patch.waitingFor === undefined) return direction;
      if (title !== undefined) direction.title = title;
      if (patch.waitingFor !== undefined) applyWaitingFor(direction, patch.waitingFor);
      direction.updatedAt = nowIso();
      return direction;
    });
  }

  async setStatus(id: string, status: Status, opts: { waitingFor?: string | null; index?: number } = {}): Promise<Direction> {
    return this.mutate(s => {
      const direction = findDirection(s, id);
      if (isJiraLed(direction) && markOf(status) === null && status !== direction.status) throw new ValidationError(jiraStageRefusal(direction));
      if (markOf(direction.status) !== null && stageOf(status) === directionStage(direction)) return unmark(s, direction, opts.index);
      direction.stage = stageOf(status) ?? directionStage(direction);
      const changed = direction.status !== status;
      if (opts.waitingFor !== undefined) applyWaitingFor(direction, opts.waitingFor);
      if (changed && status !== 'waiting') delete direction.waitingFor;
      if (changed) {
        const label = STATUS_LABELS[status];
        const text = status === 'waiting' && direction.waitingFor ? `Статус: ${label} · ${direction.waitingFor}` : `Статус: ${label}`;
        direction.events.push(newEvent(text, 'system', 'status'));
        if (status === 'done') direction.doneAt = nowIso();
        else delete direction.doneAt;
      }
      direction.updatedAt = nowIso();
      s.directions = placeDirection(s.directions, id, status, opts.index ?? columnEnd(s, status, id));
      return findDirection(s, id);
    });
  }

  /** Takes «Жду» or «Отложено» off: the direction goes to the end of its stage's column */
  async clearMark(id: string): Promise<Direction> {
    return this.mutate(s => unmark(s, findDirection(s, id)));
  }

  /** `day` is YYYY-MM-DD; kept as local noon so it stays on that day in any time zone shift */
  async setDoneDate(id: string, day: string): Promise<Direction> {
    const [year, month, date] = requireDay(day, 'Дата должна').split('-').map(Number);
    return this.mutate(s => {
      const direction = findDirection(s, id);
      if (direction.status !== 'done') throw new ValidationError(`Направление не в статусе «Готово»: ${direction.title}`);
      direction.doneAt = new Date(year, month - 1, date, 12).toISOString();
      direction.updatedAt = nowIso();
      return direction;
    });
  }

  async addEvent(id: string, text: string, source: EventSource): Promise<WorkEvent> {
    const trimmed = requireText(text, 'Текст события');
    return this.mutate(s => {
      const direction = findDirection(s, id);
      const event = newEvent(trimmed, source, 'note');
      direction.events.push(event);
      direction.updatedAt = event.at;
      return event;
    });
  }

  async addTicket(id: string, rawKey: string): Promise<Ticket> {
    const ticket = parseTicketKey(rawKey, this.profile);
    return this.mutate(s => {
      const direction = findDirection(s, id);
      const existing = direction.tickets.find(t => t.key === ticket.key);
      if (existing) return existing;
      direction.tickets.push(ticket);
      direction.updatedAt = nowIso();
      if (direction.status !== 'done') applyStage(s, direction, direction.updatedAt, this.profile);
      return ticket;
    });
  }

  async removeTicket(id: string, key: string): Promise<void> {
    const normalized = normalizeTicketKey(key) ?? key;
    return this.mutate(s => {
      const direction = findDirection(s, id);
      const tickets = direction.tickets.filter(t => t.key !== normalized);
      if (tickets.length === direction.tickets.length) return;
      direction.tickets = tickets;
      direction.updatedAt = nowIso();
      if (direction.status !== 'done') applyStage(s, direction, direction.updatedAt, this.profile);
    });
  }

  /** Statuses and Segment from a Jira poll; a changed status of a known ticket goes to the feed. Returns how many tickets changed */
  async applyJira(issues: readonly JiraIssue[], at: string): Promise<number> {
    const byKey = new Map(issues.map(issue => [issue.key, issue]));
    return this.mutate(s => {
      let changed = 0;
      // by id: a direction that changes column is replaced in s.directions
      for (const id of s.directions.map(d => d.id)) {
        const direction = findDirection(s, id);
        // the example's tickets are fake: no Jira link, no status
        if (direction.status === 'done' || isExample(direction)) continue;
        const ticketEvents: WorkEvent[] = [];
        direction.tickets = direction.tickets.map(ticket => filledTicket(ticket, this.profile));
        for (const ticket of direction.tickets) {
          const issue = byKey.get(ticket.key);
          if (issue === undefined || !jiraChanged(ticket.jira, issue)) continue;
          if (ticket.jira !== undefined && ticket.jira.status !== issue.status) {
            ticketEvents.push({ ...newEvent(`${ticket.key}: ${ticket.jira.status} → ${issue.status}`, 'jira', 'jira-status'), at });
          }
          ticket.jira = { status: issue.status, segments: [...issue.segments], at };
          changed++;
        }
        applyStage(s, direction, at, this.profile, ticketEvents);
      }
      return changed;
    });
  }

  /** `found`: branch → MR number. Adds «MR !N» to unfinished directions of that branch that do not link it yet; returns how many */
  async applyMergeRequests(found: ReadonlyMap<string, number>): Promise<number> {
    return this.mutate(s => {
      let added = 0;
      for (const direction of s.directions) {
        if (direction.status === 'done' || isExample(direction)) continue;
        const branch = directionBranch(direction.tickets, this.profile);
        const id = branch === null ? undefined : found.get(branch);
        const url = id === undefined ? null : mergeRequestUrl(id, this.profile);
        if (id === undefined || url === null || direction.links.some(link => mergeRequestNumber(link.url) === id)) continue;
        direction.links.push({ title: `MR !${id}`, url, kind: 'mr' });
        added++;
      }
      return added;
    });
  }

  async addLink(id: string, input: { url: string; title?: string; kind?: LinkKind; description?: string }): Promise<Link> {
    const url = withScheme(requireText(input.url, 'Ссылка'));
    const link: Link = { title: optionalText(input.title) ?? url, url, kind: input.kind ?? detectLinkKind(url, this.profile) };
    const description = optionalText(input.description);
    if (description !== undefined) link.description = description;
    return this.mutate(s => {
      const direction = findDirection(s, id);
      const existing = direction.links.find(l => l.url === url);
      if (existing) return existing;
      direction.links.push(link);
      direction.updatedAt = nowIso();
      return link;
    });
  }

  async setLinkDescription(id: string, url: string, description: string | null): Promise<Link> {
    return this.mutate(s => {
      const direction = findDirection(s, id);
      const link = direction.links.find(l => l.url === url);
      if (!link) throw new NotFoundError(`Ссылка не найдена: ${url}`);
      if (applyDescription(link, description)) direction.updatedAt = nowIso();
      return link;
    });
  }

  async removeLink(id: string, url: string): Promise<void> {
    return this.mutate(s => {
      const direction = findDirection(s, id);
      const links = direction.links.filter(l => l.url !== url);
      if (links.length === direction.links.length) return;
      direction.links = links;
      direction.updatedAt = nowIso();
    });
  }

  /** the onboarding example, once, into data that has nothing yet; sidebar links from the profile do not count */
  async seedExample(now: Date = new Date()): Promise<boolean> {
    return this.mutate(s => {
      const onboarding = s.onboarding ?? {};
      if (onboarding.exampleCreatedAt !== undefined || s.directions.length > 0 || s.todos.length > 0 || s.notes.length > 0 || s.dailies.length > 0) return false;
      const at = now.toISOString();
      const { direction, todo, note } = exampleData(this.profile, at, () => newId());
      s.directions.push(direction);
      s.todos.push(todo);
      s.notes.push(note);
      s.onboarding = { ...onboarding, exampleCreatedAt: at };
      return true;
    });
  }

  async setOnboarding(patch: OnboardingPatch, now: Date = new Date()): Promise<Onboarding> {
    return this.mutate(s => {
      const next: Onboarding = { ...(s.onboarding ?? {}) };
      if (patch.tourClosed === true) next.tourClosedAt = now.toISOString();
      else if (patch.tourClosed === false) delete next.tourClosedAt;
      if (patch.stepsHidden === true) next.stepsHidden = true;
      else if (patch.stepsHidden === false) delete next.stepsHidden;
      if (patch.stepsDone === true) next.stepsDoneAt ??= now.toISOString();
      else if (patch.stepsDone === false) delete next.stepsDoneAt;
      s.onboarding = next;
      return next;
    });
  }

  /** the first step about Chrome tabs; the first time stays */
  async markTabsRead(now: Date = new Date()): Promise<void> {
    return this.mutate(s => {
      const onboarding = s.onboarding ?? {};
      if (onboarding.tabsReadAt !== undefined) return;
      s.onboarding = { ...onboarding, tabsReadAt: now.toISOString() };
    });
  }

  async deleteDirection(id: string): Promise<void> {
    return this.mutate(s => {
      // the example takes its own todo and note with it: they mean nothing without it
      if (isExample(findDirection(s, id))) {
        const examples = new Set(s.directions.filter(isExample).map(d => d.id));
        s.todos = s.todos.filter(todo => todo.directionId !== id);
        // a note also about an own direction is the user's: it is only unlinked below
        s.notes = s.notes.filter(note => !note.directionIds.includes(id) || note.directionIds.some(other => !examples.has(other)));
      }
      s.directions = s.directions.filter(d => d.id !== id);
      for (const note of s.notes) {
        if (note.directionIds.includes(id)) note.directionIds = note.directionIds.filter(d => d !== id);
      }
      s.todos = s.todos.map(todo => {
        if (todo.directionId !== id) return todo;
        const copy = { ...todo };
        delete copy.directionId;
        return copy;
      });
      for (const rule of s.repeats) if (rule.directionId === id) delete rule.directionId;
    });
  }

  async addTodo(input: NewTodoInput): Promise<Todo> {
    const text = requireText(input.text, 'Текст дела');
    const requestedBy = optionalText(input.requestedBy);
    const due = input.due === undefined ? undefined : requireDue(input.due);
    const url = input.url === undefined ? undefined : requireUrl(input.url);
    const time = input.time === undefined ? undefined : requireTime(input.time);
    return this.mutate(s => {
      if (input.directionId !== undefined) findDirection(s, input.directionId);
      return insertTodo(s, { text, directionId: input.directionId, requestedBy, due, url, time });
    });
  }

  async updateTodo(id: string, patch: TodoPatch): Promise<Todo> {
    const text = patch.text === undefined ? undefined : requireText(patch.text, 'Текст дела');
    const due = patch.due === undefined || patch.due === null ? patch.due : requireDue(patch.due);
    const { url, time } = checkedLinkAndTime(patch);
    return this.mutate(s => {
      const todo = findTodo(s, id);
      if (typeof patch.directionId === 'string') findDirection(s, patch.directionId);
      if (text !== undefined) todo.text = text;
      assignOptional(todo, 'directionId', patch.directionId);
      assignOptional(todo, 'requestedBy', patch.requestedBy === undefined ? undefined : trimOrNull(patch.requestedBy));
      assignOptional(todo, 'due', due);
      assignOptional(todo, 'url', url);
      assignOptional(todo, 'time', time);
      if (patch.done !== undefined && patch.done !== todo.done) {
        todo.done = patch.done;
        if (patch.done) todo.doneAt = nowIso();
        else delete todo.doneAt;
      }
      syncDoneEvent(s, todo);
      return todo;
    });
  }

  async setTodoDone(id: string, done: boolean): Promise<Todo> {
    return this.updateTodo(id, { done });
  }

  async addRepeat(input: NewRepeatInput): Promise<RepeatRule> {
    const text = requireText(input.text, 'Текст дела');
    const requestedBy = optionalText(input.requestedBy);
    if (input.days.length === 0) throw new ValidationError('Не указаны дни повтора');
    const url = input.url === undefined ? undefined : requireUrl(input.url);
    const time = input.time === undefined ? undefined : requireTime(input.time);
    return this.mutate(s => {
      if (input.directionId !== undefined) findDirection(s, input.directionId);
      const rule: RepeatRule = {
        id: newId(),
        text,
        days: REPEAT_DAYS.filter(day => input.days.includes(day)),
        ...(input.directionId === undefined ? {} : { directionId: input.directionId }),
        ...(requestedBy === undefined ? {} : { requestedBy }),
        ...(url === undefined ? {} : { url }),
        ...(time === undefined ? {} : { time }),
        createdAt: nowIso(),
      };
      s.repeats.push(rule);
      return rule;
    });
  }

  /** the open todo the rule made changes with it; done ones keep what they had */
  async updateRepeat(id: string, patch: RepeatPatch): Promise<RepeatRule> {
    const { url, time } = checkedLinkAndTime(patch);
    return this.mutate(s => {
      const rule = findById(s.repeats, id, 'Повтор не найден');
      for (const target of [rule, ...s.todos.filter(t => t.repeatId === id && !t.done)]) {
        assignOptional(target, 'url', url);
        assignOptional(target, 'time', time);
      }
      return rule;
    });
  }

  /** the todos it already made stay as ordinary ones */
  async removeRepeat(id: string): Promise<RepeatRule> {
    return this.mutate(s => {
      const rule = findById(s.repeats, id, 'Повтор не найден');
      s.repeats = s.repeats.filter(r => r.id !== id);
      for (const todo of s.todos) if (todo.repeatId === id) delete todo.repeatId;
      return rule;
    });
  }

  /** Makes today's todo of every rule due today, once a day; an open one from an earlier day moves to today instead. Returns how many rules were applied */
  async applyRepeats(now: Date = new Date()): Promise<number> {
    const today = localDate(now);
    const day = repeatDayOf(now);
    const [repeats, todos] = await Promise.all([readRepeats(this.dataDir), readTodos(this.dataDir)]);
    if (dueRepeats(repeats, todos, today, day).length === 0) return 0;
    return this.mutate(s => {
      const steps = dueRepeats(s.repeats, s.todos, today, day);
      for (const { rule, open } of steps) {
        rule.lastOn = today;
        if (open !== undefined) {
          open.due = today;
          continue;
        }
        const todo = insertTodo(s, { text: rule.text, directionId: rule.directionId, requestedBy: rule.requestedBy, due: today, url: rule.url, time: rule.time });
        todo.repeatId = rule.id;
      }
      return steps.length;
    });
  }

  async moveTodo(id: string, index: number): Promise<void> {
    return this.mutate(s => {
      const from = s.todos.indexOf(findTodo(s, id));
      s.todos = moveInList(s.todos, from, clampIndex(index, s.todos.length));
    });
  }

  async deleteTodo(id: string): Promise<void> {
    return this.mutate(s => {
      findTodo(s, id);
      s.todos = s.todos.filter(t => t.id !== id);
    });
  }

  async addQuickLink(groupTitle: string, link: QuickLink): Promise<QuickLinkGroup> {
    const title = requireText(groupTitle, 'Название группы');
    const quickLink: QuickLink = { title: requireText(link.title, 'Название ссылки'), url: withScheme(requireText(link.url, 'Ссылка')) };
    const description = optionalText(link.description);
    if (description !== undefined) quickLink.description = description;
    return this.mutate(s => {
      let group = s.linkGroups.find(g => g.title === title);
      if (!group) {
        group = { id: newId(), title, links: [] };
        s.linkGroups.push(group);
      }
      if (group.links.some(l => l.url === quickLink.url)) return group;
      group.links.push(quickLink);
      return group;
    });
  }

  /** adds the links whose url is in no group yet; the user's own edits stay as they are */
  /** at start: a profile without Jira (or none) leaves no direction locked to it */
  async releaseJiraStages(): Promise<number> {
    // the lock only when there is something to release
    if (releasedJiraStages((await this.read()).directions, this.profile) === 0) return 0;
    return this.mutate(s => releasedJiraStages(s.directions, this.profile));
  }

  async importQuickLinks(groups: readonly ProfileLinkGroup[]): Promise<{ added: number; present: number }> {
    return this.mutate(s => {
      const known = new Set(s.linkGroups.flatMap(group => group.links.map(link => link.url)));
      let added = 0;
      let present = 0;
      for (const source of groups) {
        for (const link of source.links) {
          const url = withScheme(link.url.trim());
          if (known.has(url)) {
            present++;
            continue;
          }
          let group = s.linkGroups.find(g => g.title === source.title);
          if (!group) {
            group = { id: newId(), title: source.title, links: [] };
            s.linkGroups.push(group);
          }
          const quickLink: QuickLink = { title: link.title, url };
          if (link.description !== undefined) quickLink.description = link.description;
          group.links.push(quickLink);
          known.add(url);
          added++;
        }
      }
      return { added, present };
    });
  }

  async setQuickLinkDescription(groupId: string, url: string, description: string | null): Promise<QuickLink> {
    return this.mutate(s => {
      const group = findLinkGroup(s, groupId);
      const link = group.links.find(l => l.url === url);
      if (!link) throw new NotFoundError(`Ссылка не найдена: ${url}`);
      applyDescription(link, description);
      return link;
    });
  }

  async createNote(input: NoteInput): Promise<Note> {
    const title = requireText(input.title, 'Заголовок');
    return this.mutate(s => {
      const at = nowIso();
      const note: Note = {
        id: newId(),
        title,
        body: input.body?.trim() ?? '',
        directionIds: checkedDirectionIds(s, input.directionIds ?? []),
        files: checkedFiles(input.files ?? []),
        urls: checkedUrls(input.urls ?? []),
        createdAt: at,
        updatedAt: at,
      };
      s.notes.push(note);
      return note;
    });
  }

  async updateNote(id: string, patch: NotePatch): Promise<Note> {
    const title = patch.title === undefined ? undefined : requireText(patch.title, 'Заголовок');
    return this.mutate(s => {
      const note = findNote(s, id);
      const before = JSON.stringify(note);
      if (title !== undefined) note.title = title;
      if (patch.body !== undefined) note.body = patch.body.trim();
      if (patch.directionIds !== undefined) note.directionIds = checkedDirectionIds(s, patch.directionIds);
      if (patch.files !== undefined) note.files = checkedFiles(patch.files);
      if (patch.urls !== undefined) note.urls = checkedUrls(patch.urls);
      if (JSON.stringify(note) !== before) note.updatedAt = nowIso();
      return note;
    });
  }

  async deleteNote(id: string): Promise<void> {
    return this.mutate(s => {
      findNote(s, id);
      s.notes = s.notes.filter(n => n.id !== id);
    });
  }

  async removeQuickLink(groupId: string, url: string): Promise<void> {
    return this.mutate(s => {
      const group = findLinkGroup(s, groupId);
      group.links = group.links.filter(l => l.url !== url);
    });
  }

  async setDraftText(periodStart: string, text: string | null, now: Date = new Date()): Promise<DailyDraft> {
    return this.mutate(s => {
      const draft = currentDraft(s, periodStart, now);
      draft.text = text;
      draft.textAt = text === null ? null : now.toISOString();
      return draft;
    });
  }

  async removeSummaryItem(id: string, now: Date = new Date()): Promise<void> {
    return this.mutate(s => {
      const summary = activeSummary(s, now);
      findSummaryItem(summary, id);
      summary.items = summary.items.filter(item => item.id !== id);
    });
  }

  async setSummaryItemDirection(id: string, directionId: string | null, now: Date = new Date()): Promise<SummaryItem> {
    return this.mutate(s => {
      const item = findSummaryItem(activeSummary(s, now), id);
      if (directionId !== null) findDirection(s, directionId);
      item.directionId = directionId;
      return item;
    });
  }

  async acceptCandidate(id: string, now: Date = new Date()): Promise<Todo> {
    return this.mutate(s => {
      const summary = activeSummary(s, now);
      const candidate = findCandidate(summary, id);
      summary.candidates = summary.candidates.filter(c => c.id !== id);
      const directionId = candidate.directionId !== null && s.directions.some(d => d.id === candidate.directionId) ? candidate.directionId : undefined;
      return insertTodo(s, { text: candidate.text, directionId, requestedBy: candidate.requestedBy ?? undefined });
    });
  }

  async dismissCandidate(id: string, now: Date = new Date()): Promise<void> {
    return this.mutate(s => {
      const summary = activeSummary(s, now);
      findCandidate(summary, id);
      summary.candidates = summary.candidates.filter(c => c.id !== id);
    });
  }

  async beginSummaryRun(now: Date = new Date()): Promise<{ periodStart: string }> {
    return this.mutate(s => {
      // checked before the draft is replaced: a run of yesterday's period may still be going after midnight
      if (summaryRunState(s.draft?.run ?? null, now) === 'running') throw new ConflictError('Сборка из сессий уже идёт');
      const periodStart = currentPeriodStart(now, s.dailies);
      const draft = currentDraft(s, periodStart, now);
      draft.run = { status: 'running', startedAt: now.toISOString(), baseTextAt: draft.textAt };
      return { periodStart };
    });
  }

  /** a run left «running» by a server that stopped will never finish */
  async abandonSummaryRun(now: Date = new Date()): Promise<void> {
    return this.mutate(s => {
      if (s.draft?.run?.status !== 'running') return;
      s.draft.run = { status: 'failed', at: now.toISOString(), error: 'сборка прервалась: сервер перезапускался' };
    });
  }

  async finishSummaryRun(periodStart: string, outcome: SummaryOutcome, now: Date = new Date()): Promise<void> {
    return this.mutate(s => {
      const draft = activeDraft(s, periodStart);
      // the daily was held or the period rolled over while claude was working
      if (draft === null || currentPeriodStart(now, s.dailies) !== periodStart) return;
      if ('error' in outcome) {
        draft.run = { status: 'failed', at: now.toISOString(), error: outcome.error };
        return;
      }
      const textUntouched = draft.run?.status === 'running' && draft.run.baseTextAt === draft.textAt;
      draft.summary = outcome.summary;
      draft.run = null;
      if (textUntouched && outcome.prose !== null && outcome.prose.trim() !== '') {
        draft.text = outcome.prose;
        draft.textAt = outcome.summary.ranAt;
      }
    });
  }

  async holdDaily(input: { periodStart: string; text: string }, now: Date = new Date()): Promise<Daily> {
    const text = requireText(input.text, 'Текст дейлика');
    return this.mutate(s => {
      requirePeriod(s, input.periodStart, now);
      const summary = activeDraft(s, input.periodStart)?.summary ?? null;
      const digest = periodDigest(s, input.periodStart, summary, localDate(now));
      for (const group of digest.groups) {
        for (const item of group.items) {
          insertByTime(group.direction.events, { id: newId(), at: item.at, text: item.text, source: 'session-summary', kind: 'note' });
          group.direction.updatedAt = now.toISOString();
        }
      }
      const daily: Daily = { id: newId(), heldAt: now.toISOString(), periodStart: input.periodStart, text, items: dailyItems(digest) };
      s.dailies.push(daily);
      s.draft = null;
      return daily;
    });
  }

  /** the run with the prompt built from the state it was started in */
  async startRun(request: AgentRequest, now: Date = new Date()): Promise<{ run: AgentRun; prompt: string }> {
    const branch = request.branch.trim();
    if (!isBranchName(branch)) throw new ValidationError(`Некорректное имя ветки: ${request.branch}`);
    if (AGENT_TEMPLATES_NEEDING_EXTRA.includes(request.template) && request.extra.trim() === '') {
      throw new ValidationError(`Для «${AGENT_TEMPLATE_LABELS[request.template]}» нужен дополнительный контекст`);
    }
    const aboutNothing = request.directionId === undefined && request.todoId === undefined;
    if (DIRECTIONLESS_TEMPLATES.includes(request.template)) {
      if (!aboutNothing) throw new ValidationError('Разбор вкладок не привязан к направлению');
    } else if (aboutNothing) throw new ValidationError('Поручение должно быть о направлении или деле');
    return this.mutate(s => {
      if (request.todoId !== undefined) findTodo(s, request.todoId);
      else if (request.directionId !== undefined) findDirection(s, request.directionId);
      const context = agentContext(s, request);
      if (context.direction !== undefined && isExample(context.direction)) throw new ValidationError('В примере агент не запускается');
      const run: AgentRun = {
        id: newId(),
        ...(request.agent === undefined ? {} : { agent: request.agent }),
        template: request.template,
        ...(context.direction === undefined ? {} : { directionId: context.direction.id }),
        ...(context.todo === undefined ? {} : { todoId: context.todo.id }),
        branch,
        title: agentRunTitle(context, request.template),
        startedAt: now.toISOString(),
      };
      s.runs.push(run);
      return { run, prompt: agentPrompt(s, { ...request, branch }, run.id, this.profile) };
    });
  }

  async finishRun(id: string, now: Date = new Date()): Promise<AgentRun> {
    return this.mutate(s => {
      const run = findRun(s, id);
      if (run.finishedAt === undefined) run.finishedAt = now.toISOString();
      return run;
    });
  }

  /** a run whose tab never opened */
  async discardRun(id: string): Promise<void> {
    return this.mutate(s => {
      s.runs = s.runs.filter(run => run.id !== id);
    });
  }

  async removeQuickLinkGroup(groupId: string): Promise<void> {
    return this.mutate(s => {
      findLinkGroup(s, groupId);
      s.linkGroups = s.linkGroups.filter(g => g.id !== groupId);
    });
  }
}

type NotPromise<T> = T extends PromiseLike<unknown> ? never : T;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && 'then' in value && typeof value.then === 'function';
}

function assertUniqueDirectionIds(directions: readonly Direction[]): void {
  const seen = new Set<string>();
  for (const { id } of directions) {
    if (seen.has(id)) throw new Error(`Два направления с одним id: ${id}`);
    seen.add(id);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function jiraChanged(known: TicketJira | undefined, issue: JiraIssue): boolean {
  return known === undefined || known.status !== issue.status || known.segments.join(',') !== issue.segments.join(',');
}

function newEvent(text: string, source: EventSource, kind: WorkEvent['kind']): WorkEvent {
  return { id: newId(), at: nowIso(), text, source, kind };
}

function columnEnd(s: WorklogState, status: Status, id: string): number {
  return s.directions.filter(d => d.status === status && d.id !== id).length;
}

function jiraStageRefusal(direction: Direction): string {
  return `Этап направления «${direction.title}» берётся из Jira (сейчас: ${STATUS_LABELS[directionStage(direction)]}). Можно поставить пометку: wait, parked`;
}

/** directions whose stage came from Jira go back to manual when the profile cannot give them one */
export function releasedJiraStages(directions: Direction[], profile: Profile | null): number {
  let released = 0;
  for (const direction of directions) {
    if (direction.stageFromJira !== true || jiraStage(direction.tickets, directionStage(direction), profile) !== null) continue;
    delete direction.stageFromJira;
    released++;
  }
  return released;
}

/** the stage from the tickets' Jira data: the event to write and the column to move to */
function restage(direction: Direction, at: string, profile: Profile | null): { event: WorkEvent | null; column: Stage | null } {
  const current = directionStage(direction);
  const derived = jiraStage(direction.tickets, current, profile);
  if (derived === null) {
    delete direction.stageFromJira;
    return { event: null, column: null };
  }
  const ledBefore = isJiraLed(direction);
  direction.stageFromJira = true;
  direction.stage = derived;
  if (derived === current) return { event: null, column: null };
  const event = ledBefore ? { ...newEvent(`Статус: ${STATUS_LABELS[derived]}`, 'jira', 'status'), at } : null;
  return { event, column: markOf(direction.status) === null ? derived : null };
}

/** the stage event goes before the ticket events of the same poll; a new column takes the direction at its end */
function applyStage(s: WorklogState, direction: Direction, at: string, profile: Profile | null, ticketEvents: readonly WorkEvent[] = []): void {
  const { event, column } = restage(direction, at, profile);
  if (event !== null) direction.events.push(event);
  direction.events.push(...ticketEvents);
  if (column === null) return;
  if (column === 'done') direction.doneAt = at;
  s.directions = placeDirection(s.directions, direction.id, column, columnEnd(s, column, direction.id));
}

function unmark(s: WorklogState, direction: Direction, index?: number): Direction {
  const mark = markOf(direction.status);
  if (mark === null) return direction;
  const now = nowIso();
  const stage = directionStage(direction);
  direction.events.push(newEvent(markClearedText(mark, direction.waitingFor), 'system', 'status'));
  delete direction.waitingFor;
  direction.stage = stage;
  if (stage === 'done') {
    direction.doneAt = now;
    direction.events.push(newEvent(`Статус: ${STATUS_LABELS.done}`, isJiraLed(direction) ? 'jira' : 'system', 'status'));
  }
  direction.updatedAt = now;
  s.directions = placeDirection(s.directions, direction.id, stage, index ?? columnEnd(s, stage, direction.id));
  return findDirection(s, direction.id);
}

// keeps the todo-done event in step with the todo: text, direction, presence; id and at survive a move
function syncDoneEvent(state: WorklogState, todo: Todo): void {
  const target = todo.done ? state.directions.find(d => d.id === todo.directionId) : undefined;
  const text = todoLabel(todo);
  let moved: WorkEvent | undefined;
  let kept = false;
  for (const direction of state.directions) {
    const index = direction.events.findIndex(e => e.kind === 'todo-done' && e.todoId === todo.id);
    if (index < 0) continue;
    const event = direction.events[index];
    if (direction === target && !kept) {
      kept = true;
      if (event.text === text) continue;
      direction.events[index] = { ...event, text };
    } else {
      moved = moved ?? event;
      direction.events.splice(index, 1);
    }
    direction.updatedAt = nowIso();
  }
  if (!target || kept) return;
  insertByTime(target.events, moved ? { ...moved, text } : { ...newEvent(text, 'system', 'todo-done'), todoId: todo.id });
  target.updatedAt = nowIso();
}

function insertByTime(events: WorkEvent[], event: WorkEvent): void {
  const index = events.findIndex(e => e.at > event.at);
  if (index < 0) events.push(event);
  else events.splice(index, 0, event);
}

function insertTodo(state: WorklogState, input: { text: string; directionId?: string; requestedBy?: string; due?: string; url?: string; time?: string }): Todo {
  const todo: Todo = {
    id: newId(),
    text: input.text,
    ...(input.directionId === undefined ? {} : { directionId: input.directionId }),
    ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
    ...(input.due === undefined ? {} : { due: input.due }),
    ...(input.url === undefined ? {} : { url: input.url }),
    ...(input.time === undefined ? {} : { time: input.time }),
    done: false,
    createdAt: nowIso(),
  };
  state.todos.unshift(todo);
  return todo;
}

function requirePeriod(state: WorklogState, periodStart: string, now: Date): void {
  if (currentPeriodStart(now, state.dailies) !== periodStart) throw new ValidationError('Период дейлика сменился — обновите экран');
}

// the draft of the period, replacing a draft left from an earlier one
function currentDraft(state: WorklogState, periodStart: string, now: Date): DailyDraft {
  requirePeriod(state, periodStart, now);
  const existing = activeDraft(state, periodStart);
  if (existing !== null) return existing;
  const draft: DailyDraft = { periodStart, text: null, textAt: null, summary: null, run: null };
  state.draft = draft;
  return draft;
}

function activeSummary(state: WorklogState, now: Date): SessionSummary {
  const summary = activeDraft(state, currentPeriodStart(now, state.dailies))?.summary;
  if (!summary) throw new NotFoundError('Выжимки из сессий за этот период нет');
  return summary;
}

/** `missing` is the message head, such as «Дело не найдено» */
function findById<T extends { id: string }>(list: readonly T[], id: string, missing: string): T {
  const found = list.find(item => item.id === id);
  if (!found) throw new NotFoundError(`${missing}: ${id}`);
  return found;
}

function findSummaryItem(summary: SessionSummary, id: string): SummaryItem {
  return findById(summary.items, id, 'Пункт выжимки не найден');
}

function findCandidate(summary: SessionSummary, id: string): TodoCandidate {
  return findById(summary.candidates, id, 'Кандидат в дела не найден');
}

function findDirection(state: WorklogState, id: string): Direction {
  return findById(state.directions, id, 'Направление не найдено');
}

function findNote(state: WorklogState, id: string): Note {
  return findById(state.notes, id, 'Заметка не найдена');
}

function findLinkGroup(state: WorklogState, id: string): QuickLinkGroup {
  return findById(state.linkGroups, id, 'Группа ссылок не найдена');
}

function checkedDirectionIds(state: WorklogState, ids: readonly string[]): string[] {
  for (const id of ids) findDirection(state, id);
  return [...new Set(ids)];
}

export function checkedNoteFile(file: NoteFile): NoteFile {
  if (!isSafeRelativePath(file.path)) throw new ValidationError(`Путь к файлу должен быть относительным и без «..»: ${file.path}`);
  if (file.line === undefined) return { path: file.path };
  if (!isLineNumber(file.line)) throw new ValidationError(`Номер строки должен быть целым больше нуля: ${file.line}`);
  return { path: file.path, line: file.line };
}

function checkedFiles(files: readonly NoteFile[]): NoteFile[] {
  const result: NoteFile[] = [];
  for (const file of files) {
    const checked = checkedNoteFile({ ...file, path: file.path.trim() });
    if (!result.some(r => r.path === checked.path && r.line === checked.line)) result.push(checked);
  }
  return result;
}

function checkedUrls(urls: readonly NoteUrl[]): NoteUrl[] {
  const result: NoteUrl[] = [];
  for (const item of urls) {
    const url = withScheme(requireText(item.url, 'Ссылка'));
    if (result.some(r => r.url === url)) continue;
    const title = optionalText(item.title);
    result.push(title === undefined ? { url } : { url, title });
  }
  return result;
}

/** true when the description changed; an empty one removes it */
function applyDescription(link: { description?: string }, description: string | null): boolean {
  const next = description === null ? undefined : optionalText(description);
  if (next === link.description) return false;
  if (next === undefined) delete link.description;
  else link.description = next;
  return true;
}

function findRun(state: WorklogState, id: string): AgentRun {
  return findById(state.runs, id, 'Запуск агента не найден');
}

function findTodo(state: WorklogState, id: string): Todo {
  return findById(state.todos, id, 'Дело не найдено');
}

function requireText(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === '') throw new ValidationError(`${label}: пустое значение`);
  return trimmed;
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function trimOrNull(value: string | null): string | null {
  return value === null ? null : (optionalText(value) ?? null);
}

function requireUrl(value: string): string {
  return withScheme(requireText(value, 'Ссылка'));
}

function requireTime(value: string): string {
  const time = parseTime(value);
  if (time === null) throw new ValidationError(`Время должно быть в формате ЧЧ:ММ: ${value}`);
  return time;
}

function checkedLinkAndTime(patch: { url?: string | null; time?: string | null }): { url: string | null | undefined; time: string | null | undefined } {
  return {
    url: patch.url === undefined || patch.url === null ? patch.url : requireUrl(patch.url),
    time: patch.time === undefined || patch.time === null ? patch.time : requireTime(patch.time),
  };
}

/** `subject` with its verb: «Срок должен» */
function requireDay(value: string, subject: string): string {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!DUE_PATTERN.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ValidationError(`${subject} быть в формате YYYY-MM-DD: ${value}`);
  }
  return value;
}

function requireDue(value: string): string {
  return requireDay(value, 'Срок должен');
}

/** a ticket added without a profile gets its platform and link once the profile gives them; a stored link stays */
function filledTicket(ticket: Ticket, profile: Profile | null): Ticket {
  if (ticket.url !== '') return ticket;
  const filled = ticketFromKey(ticket.key, profile);
  return filled.url === '' ? ticket : { ...filled, ...(ticket.jira === undefined ? {} : { jira: ticket.jira }) };
}

function parseTicketKey(raw: string, profile: Profile | null): Ticket {
  const key = normalizeTicketKey(raw);
  if (!key) throw new ValidationError(`Некорректный ключ задачи: ${raw}`);
  return ticketFromKey(key, profile);
}

function uniqueTickets(tickets: Ticket[]): Ticket[] {
  return tickets.filter((ticket, index) => tickets.findIndex(t => t.key === ticket.key) === index);
}

function applyWaitingFor(direction: Direction, waitingFor: string | null): void {
  const text = waitingFor === null ? undefined : optionalText(waitingFor);
  if (text === undefined) delete direction.waitingFor;
  else direction.waitingFor = text;
}

type TodoOptionalField = 'directionId' | 'requestedBy' | 'due' | 'url' | 'time';

function assignOptional(target: Partial<Record<TodoOptionalField, string>>, field: TodoOptionalField, value: string | null | undefined): void {
  if (value === undefined) return;
  if (value === null) delete target[field];
  else target[field] = value;
}

async function readState(dataDir: string): Promise<WorklogState> {
  const [directions, todos, repeats, linkGroups, dailies, draft, notes, runs, onboarding] = await Promise.all([
    readRecords(path.join(dataDir, DIRECTIONS_DIR), JSON_EXT, jsonRecord(isDirection)),
    readTodos(dataDir),
    readRepeats(dataDir),
    readJsonFile<QuickLinkGroup[]>(path.join(dataDir, LINKS_FILE), [], isLinkGroupList),
    readRecords(path.join(dataDir, DAILIES_DIR), JSON_EXT, jsonRecord(isDaily)),
    readJsonFile<DailyDraft | null>(path.join(dataDir, DRAFT_FILE), null, isDailyDraft),
    readRecords(path.join(dataDir, NOTES_DIR), NOTE_EXT, parseNote),
    readRecords(path.join(dataDir, RUNS_DIR), JSON_EXT, jsonRecord(isAgentRun)),
    readJsonFile<Onboarding>(path.join(dataDir, ONBOARDING_FILE), {}, isOnboarding),
  ]);
  dailies.sort((a, b) => compareText(a.heldAt, b.heldAt));
  // no onboarding yet reads as the state did before it existed
  return { directions, todos, repeats, linkGroups, dailies, draft, notes, runs, ...(Object.keys(onboarding).length > 0 ? { onboarding } : {}) };
}

function readTodos(dataDir: string): Promise<Todo[]> {
  return readJsonFile<Todo[]>(path.join(dataDir, TODOS_FILE), [], isTodoList);
}

function readRepeats(dataDir: string): Promise<RepeatRule[]> {
  return readJsonFile<RepeatRule[]>(path.join(dataDir, REPEATS_FILE), [], isRepeatList);
}

/** a record from its file's text, null or a throw when the text is not one with this id */
type RecordParser<T> = (id: string, text: string) => T | null;

function jsonRecord<T extends { id: string }>(guard: Guard<T>): RecordParser<T> {
  return (id, text) => {
    const value: unknown = JSON.parse(text);
    return guard(value) && value.id === id ? value : null;
  };
}

/** one file per record, named by its id */
async function readRecords<T>(dir: string, ext: string, parse: RecordParser<T>): Promise<T[]> {
  const names = (await readdirIfExists(dir)).filter(name => name.endsWith(ext)).sort();
  const records = await Promise.all(
    names.map(async name => {
      const file = path.join(dir, name);
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (error) {
        // deleted by a concurrent mutate after readdir listed it
        if (isErrorCode(error, 'ENOENT')) return null;
        throw error;
      }
      let record: T | null;
      try {
        record = parse(name.slice(0, -ext.length), text);
      } catch (cause) {
        throw new DataError(`Повреждён файл данных: ${file}`, { cause });
      }
      if (record === null) throw new DataError(`Повреждён файл данных: ${file}`);
      return record;
    }),
  );
  return records.filter(record => record !== null);
}

/** every data file of the state: compact JSON to compare, notes as their file text */
function fileTexts(dataDir: string, state: WorklogState): Map<string, string> {
  const texts = new Map<string, string>();
  const record = (dir: string, value: { id: string }): void => {
    texts.set(path.join(dataDir, dir, `${value.id}${JSON_EXT}`), JSON.stringify(value));
  };
  for (const direction of state.directions) record(DIRECTIONS_DIR, direction);
  texts.set(path.join(dataDir, TODOS_FILE), JSON.stringify(state.todos));
  if (state.repeats.length > 0) texts.set(path.join(dataDir, REPEATS_FILE), JSON.stringify(state.repeats));
  texts.set(path.join(dataDir, LINKS_FILE), JSON.stringify(state.linkGroups));
  for (const daily of state.dailies) record(DAILIES_DIR, daily);
  if (state.draft !== null) texts.set(path.join(dataDir, DRAFT_FILE), JSON.stringify(state.draft));
  for (const run of state.runs) record(RUNS_DIR, run);
  for (const note of state.notes) texts.set(path.join(dataDir, NOTES_DIR, `${note.id}${NOTE_EXT}`), serializeNote(note));
  if (state.onboarding !== undefined && Object.keys(state.onboarding).length > 0) texts.set(path.join(dataDir, ONBOARDING_FILE), JSON.stringify(state.onboarding));
  return texts;
}

// one by one: a failed write must stop the commit before the lock is released
async function writeFiles(files: readonly { file: string; text: string | null }[]): Promise<void> {
  for (const { file, text } of files) {
    if (text === null) await rm(file, { force: true });
    else if (file.endsWith(NOTE_EXT)) await writeTextAtomic(file, text);
    // formatted only on the way to disk: only the changed files pay for it
    else await writeJsonAtomic(file, JSON.parse(text));
  }
}

const isStatus = oneOf(STATUSES);
const isStage = oneOf(STAGES);
const isLinkKind = oneOf(LINK_KINDS);
const isEventSource = oneOf(EVENT_SOURCES);
const isEventKind = oneOf(EVENT_KINDS);
const isDailyItemOrigin = oneOf(DAILY_ITEM_ORIGINS);
const isAgentTemplate = oneOf(AGENT_TEMPLATES);
const isAgent = oneOf(AGENTS);
const isTodoList = arrayOf(isTodo);
const isRepeatList = arrayOf(isRepeatRule);
const isLinkGroupList = arrayOf(isQuickLinkGroup);

function isTicket(v: unknown): v is Ticket {
  return isRecord(v) && isString(v.key) && isString(v.platform) && isString(v.url) && (v.jira === undefined || isTicketJira(v.jira));
}

function isTicketJira(v: unknown): v is TicketJira {
  return isRecord(v) && isString(v.status) && isStringArray(v.segments) && isString(v.at);
}

function isLink(v: unknown): v is Link {
  return isRecord(v) && isString(v.title) && isString(v.url) && isLinkKind(v.kind) && isOptionalString(v.description);
}

function isWorkEvent(v: unknown): v is WorkEvent {
  return (
    isRecord(v) &&
    isString(v.id) &&
    isString(v.at) &&
    isString(v.text) &&
    isEventSource(v.source) &&
    isEventKind(v.kind) &&
    isOptionalString(v.todoId)
  );
}

function isOnboarding(v: unknown): v is Onboarding {
  return isRecord(v) && isOptionalString(v.tourClosedAt) && (v.stepsHidden === undefined || v.stepsHidden === true) && isOptionalString(v.exampleCreatedAt) && isOptionalString(v.tabsReadAt) && isOptionalString(v.stepsDoneAt);
}

function isDirection(v: unknown): v is Direction {
  return (
    isRecord(v) &&
    isString(v.id) &&
    isString(v.title) &&
    isStatus(v.status) &&
    isOptionalString(v.waitingFor) &&
    (v.stage === undefined || isStage(v.stage)) &&
    (v.stageFromJira === undefined || v.stageFromJira === true) &&
    arrayOf(isTicket)(v.tickets) &&
    arrayOf(isLink)(v.links) &&
    arrayOf(isWorkEvent)(v.events) &&
    typeof v.order === 'number' &&
    isString(v.createdAt) &&
    isString(v.updatedAt) &&
    isOptionalString(v.doneAt) &&
    (v.example === undefined || v.example === true)
  );
}

function isTodo(v: unknown): v is Todo {
  return (
    isRecord(v) &&
    isString(v.id) &&
    isString(v.text) &&
    isOptionalString(v.directionId) &&
    isOptionalString(v.requestedBy) &&
    isOptionalString(v.due) &&
    typeof v.done === 'boolean' &&
    isOptionalString(v.doneAt) &&
    isString(v.createdAt) &&
    isOptionalString(v.repeatId) &&
    isOptionalString(v.url) &&
    isOptionalString(v.time)
  );
}

function isRepeatRule(v: unknown): v is RepeatRule {
  return (
    isRecord(v) &&
    isString(v.id) &&
    isString(v.text) &&
    Array.isArray(v.days) &&
    v.days.length > 0 &&
    v.days.every(oneOf(REPEAT_DAYS)) &&
    isOptionalString(v.directionId) &&
    isOptionalString(v.requestedBy) &&
    isOptionalString(v.url) &&
    isOptionalString(v.time) &&
    isString(v.createdAt) &&
    isOptionalString(v.lastOn)
  );
}

function isQuickLink(v: unknown): v is QuickLink {
  return isRecord(v) && isString(v.title) && isString(v.url) && isOptionalString(v.description);
}

function isQuickLinkGroup(v: unknown): v is QuickLinkGroup {
  return isRecord(v) && isString(v.id) && isString(v.title) && arrayOf(isQuickLink)(v.links);
}

function isSummaryItem(v: unknown): v is SummaryItem {
  return isRecord(v) && isString(v.id) && isString(v.sessionId) && isString(v.at) && isNullableString(v.directionId) && isString(v.text);
}

function isTodoCandidate(v: unknown): v is TodoCandidate {
  return isRecord(v) && isString(v.id) && isString(v.sessionId) && isString(v.text) && isNullableString(v.requestedBy) && isNullableString(v.directionId);
}

function isSessionSummary(v: unknown): v is SessionSummary {
  return isRecord(v) && isString(v.ranAt) && typeof v.sessionCount === 'number' && arrayOf(isSummaryItem)(v.items) && arrayOf(isTodoCandidate)(v.candidates);
}

function isSummaryRun(v: unknown): v is SummaryRun {
  if (!isRecord(v)) return false;
  if (v.status === 'running') return isString(v.startedAt) && isNullableString(v.baseTextAt);
  return v.status === 'failed' && isString(v.at) && isString(v.error);
}

function isDailyDraft(v: unknown): v is DailyDraft {
  return (
    isRecord(v) &&
    isString(v.periodStart) &&
    isNullableString(v.text) &&
    isNullableString(v.textAt) &&
    (v.summary === null || isSessionSummary(v.summary)) &&
    (v.run === null || isSummaryRun(v.run))
  );
}

function isDailyItem(v: unknown): v is Daily['items'][number] {
  return (
    isRecord(v) &&
    isNullableString(v.directionId) &&
    isNullableString(v.directionTitle) &&
    isString(v.text) &&
    isDailyItemOrigin(v.origin) &&
    (v.eventSource === undefined || isEventSource(v.eventSource))
  );
}

function isDaily(v: unknown): v is Daily {
  return isRecord(v) && isString(v.id) && isString(v.heldAt) && isString(v.periodStart) && isString(v.text) && arrayOf(isDailyItem)(v.items);
}

function isAgentRun(v: unknown): v is AgentRun {
  return (
    isRecord(v) &&
    isString(v.id) &&
    (v.agent === undefined || isAgent(v.agent)) &&
    isAgentTemplate(v.template) &&
    isOptionalString(v.directionId) &&
    isOptionalString(v.todoId) &&
    isString(v.branch) &&
    isString(v.title) &&
    isString(v.startedAt) &&
    isOptionalString(v.finishedAt)
  );
}
