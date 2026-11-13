export const STATUSES = ['in_progress', 'waiting', 'in_review', 'testing', 'awaiting_release', 'parked', 'done'] as const;
export type Status = (typeof STATUSES)[number];

export const BOARD_STATUSES = ['in_progress', 'waiting', 'in_review', 'testing', 'awaiting_release'] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

/** where the work is; a direction's column unless a mark puts it elsewhere */
export const STAGES = ['in_progress', 'in_review', 'testing', 'awaiting_release', 'done'] as const;
export type Stage = (typeof STAGES)[number];

/** set by hand over the stage */
export const MARKS = ['waiting', 'parked'] as const;
export type Mark = (typeof MARKS)[number];

export function stageOf(status: Status): Stage | null {
  return STAGES.find(stage => stage === status) ?? null;
}

export function markOf(status: Status): Mark | null {
  return MARKS.find(mark => mark === status) ?? null;
}

export const STATUS_LABELS: Record<Status, string> = {
  in_progress: 'В работе',
  waiting: 'Жду',
  in_review: 'В мерж реквесте',
  testing: 'Тестирование',
  awaiting_release: 'Ждёт релиза',
  parked: 'Отложено',
  done: 'Готово',
};

export const STATUS_ALIASES = {
  work: 'in_progress',
  wait: 'waiting',
  mr: 'in_review',
  review: 'in_review',
  test: 'testing',
  release: 'awaiting_release',
  parked: 'parked',
  done: 'done',
  in_progress: 'in_progress',
  waiting: 'waiting',
  in_review: 'in_review',
  testing: 'testing',
  awaiting_release: 'awaiting_release',
} as const satisfies Record<string, Status>;

export function statusFromAlias(raw: string): Status | undefined {
  return Object.entries(STATUS_ALIASES).find(([alias]) => alias === raw)?.[1];
}

export const EVENT_SOURCES = ['manual', 'claude', 'session-summary', 'system', 'jira'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const EVENT_KINDS = ['note', 'status', 'todo-done', 'jira-status'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const LINK_KINDS = ['confluence', 'figma', 'mr', 'branch', 'jenkins', 'other'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** the platform of a ticket outside the profile's projects */
export const OTHER_PLATFORM = 'other';
/** a project label from the profile, or OTHER_PLATFORM */
export type TicketPlatform = string;

export interface TicketJira {
  status: string;
  /** Segment values as Jira gives them */
  segments: string[];
  /** when the status or segments last changed, ISO */
  at: string;
}

export interface Ticket {
  key: string;
  platform: TicketPlatform;
  url: string;
  /** the last known status from Jira; none until Jira was asked */
  jira?: TicketJira;
}

export interface Link {
  title: string;
  url: string;
  kind: LinkKind;
  /** what the page is and anything useful about it, several lines */
  description?: string;
}

export interface WorkEvent {
  id: string;
  at: string;
  text: string;
  source: EventSource;
  kind: EventKind;
  todoId?: string;
}

export interface Direction {
  id: string;
  title: string;
  /** the column: a mark when there is one, otherwise the stage */
  status: Status;
  waitingFor?: string;
  /** files written before 2026-11-06 lack it: read it through `directionStage` */
  stage?: Stage;
  /** the stage comes from the Jira statuses of its tickets in the profile's projects */
  stageFromJira?: true;
  tickets: Ticket[];
  links: Link[];
  events: WorkEvent[];
  order: number;
  createdAt: string;
  updatedAt: string;
  /** when it became done, ISO */
  doneAt?: string;
  /** the onboarding example: kept out of the daily, Jira, MR lookups and agent runs */
  example?: true;
}

export interface Todo {
  id: string;
  text: string;
  directionId?: string;
  requestedBy?: string;
  /** YYYY-MM-DD */
  due?: string;
  done: boolean;
  doneAt?: string;
  createdAt: string;
  /** made by this repeat rule */
  repeatId?: string;
  url?: string;
  /** HH:MM */
  time?: string;
}

export const REPEAT_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type RepeatDay = (typeof REPEAT_DAYS)[number];
const WEEKDAYS: readonly RepeatDay[] = REPEAT_DAYS.slice(0, 5);
const REPEAT_DAY_FORMS: Record<RepeatDay, { short: string; plural: string }> = {
  mon: { short: 'пн', plural: 'по понедельникам' },
  tue: { short: 'вт', plural: 'по вторникам' },
  wed: { short: 'ср', plural: 'по средам' },
  thu: { short: 'чт', plural: 'по четвергам' },
  fri: { short: 'пт', plural: 'по пятницам' },
  sat: { short: 'сб', plural: 'по субботам' },
  sun: { short: 'вс', plural: 'по воскресеньям' },
};

/** a todo made anew on each of its days */
export interface RepeatRule {
  id: string;
  text: string;
  days: RepeatDay[];
  directionId?: string;
  requestedBy?: string;
  /** given to the todos it makes */
  url?: string;
  /** HH:MM */
  time?: string;
  createdAt: string;
  /** YYYY-MM-DD of the last day it was applied */
  lastOn?: string;
}

/** `day`, `weekdays` or days separated by commas: `mon,thu` */
export function parseRepeatDays(spec: string): RepeatDay[] | null {
  const value = spec.trim().toLowerCase();
  if (value === 'day') return [...REPEAT_DAYS];
  if (value === 'weekdays') return [...WEEKDAYS];
  const parts = value.split(',').map(part => part.trim());
  const days = REPEAT_DAYS.filter(day => parts.includes(day));
  return days.length > 0 && days.length === new Set(parts).size ? days : null;
}

const TIME_PATTERN = /^(\d{1,2})[:.](\d{2})$/;

/** `H:MM`, `HH:MM` or with a dot: `12.00` → `HH:MM` */
export function parseTime(raw: string): string | null {
  const match = TIME_PATTERN.exec(raw.trim());
  if (match === null) return null;
  const [hours, minutes] = [Number(match[1]), Number(match[2])];
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${match[2]}`;
}

export function repeatLabel(days: readonly RepeatDay[]): string {
  if (days.length === REPEAT_DAYS.length) return 'каждый день';
  if (days.length === WEEKDAYS.length && WEEKDAYS.every(day => days.includes(day))) return 'по будням';
  if (days.length === 1) return REPEAT_DAY_FORMS[days[0]].plural;
  return REPEAT_DAYS.filter(day => days.includes(day)).map(day => REPEAT_DAY_FORMS[day].short).join(', ');
}

export function repeatDayOf(date: Date): RepeatDay {
  return REPEAT_DAYS[(date.getDay() + 6) % 7];
}

export type RepeatStep = { rule: RepeatRule; open: Todo | undefined };

/** rules due on `today` (YYYY-MM-DD, weekday `day`) not applied yet, with the open todo each one made before */
export function dueRepeats(rules: readonly RepeatRule[], todos: readonly Todo[], today: string, day: RepeatDay): RepeatStep[] {
  return rules
    .filter(rule => rule.days.includes(day) && (rule.lastOn === undefined || rule.lastOn < today))
    .map(rule => ({ rule, open: todos.find(t => t.repeatId === rule.id && !t.done) }));
}

export interface QuickLink {
  title: string;
  url: string;
  description?: string;
}

export interface QuickLinkGroup {
  id: string;
  title: string;
  links: QuickLink[];
}

export const DAILY_HOUR = 11;
export const DAILY_MINUTE = 30;
/** a run marked running for longer than this was interrupted (the server timeout is shorter) */
export const SUMMARY_STALE_MS = 360_000;

export const SUMMARY_LIMITS = { messageChars: 1500, sessionChars: 20_000, totalChars: 300_000 } as const;

export interface SummaryItem {
  id: string;
  sessionId: string;
  /** the last message of the session in the period */
  at: string;
  directionId: string | null;
  text: string;
}

export interface TodoCandidate {
  id: string;
  sessionId: string;
  text: string;
  requestedBy: string | null;
  directionId: string | null;
}

export interface SessionSummary {
  ranAt: string;
  sessionCount: number;
  items: SummaryItem[];
  candidates: TodoCandidate[];
}

/** `baseTextAt`: the text's `textAt` when the run started; a text changed since is the user's and stays */
export type SummaryRun = { status: 'running'; startedAt: string; baseTextAt: string | null } | { status: 'failed'; at: string; error: string };

export interface DailyDraft {
  periodStart: string;
  /** null: the screen shows the live template */
  text: string | null;
  textAt: string | null;
  summary: SessionSummary | null;
  run: SummaryRun | null;
}

export const DAILY_ITEM_ORIGINS = ['event', 'summary'] as const;
export type DailyItemOrigin = (typeof DAILY_ITEM_ORIGINS)[number];

export interface DailyItem {
  directionId: string | null;
  directionTitle: string | null;
  text: string;
  origin: DailyItemOrigin;
  eventSource?: EventSource;
}

export interface Daily {
  id: string;
  heldAt: string;
  periodStart: string;
  text: string;
  items: DailyItem[];
}

/** a path relative to the code root (the project repository) */
export interface NoteFile {
  path: string;
  line?: number;
}

export interface NoteUrl {
  url: string;
  title?: string;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  directionIds: string[];
  files: NoteFile[];
  urls: NoteUrl[];
  createdAt: string;
  updatedAt: string;
}

export const AGENT_TEMPLATES = ['execute', 'decompose', 'docs', 'question', 'custom', 'tabs'] as const;
export type AgentTemplate = (typeof AGENT_TEMPLATES)[number];

/** the task window offers these; the others start from their own buttons */
export const AGENT_SHEET_TEMPLATES = ['execute', 'decompose', 'docs', 'question', 'custom'] as const satisfies readonly AgentTemplate[];
export type AgentSheetTemplate = (typeof AGENT_SHEET_TEMPLATES)[number];

/** about neither a direction nor a todo, and never touching git */
export const DIRECTIONLESS_TEMPLATES: readonly AgentTemplate[] = ['tabs'];

export const AGENT_TEMPLATE_LABELS: Record<AgentTemplate, string> = {
  execute: 'Выполнить задачу',
  decompose: 'Декомпозировать',
  docs: 'Изучить доки → ссылки',
  question: 'Вопрос',
  custom: 'Своё',
  tabs: 'Разобрать вкладки Chrome',
};

/** these say nothing by themselves: the task is in the extra context */
export const AGENT_TEMPLATES_NEEDING_EXTRA: readonly AgentTemplate[] = ['question', 'custom'];

export const AGENT_CONTEXT_PARTS = ['tickets', 'links', 'events', 'todos', 'notes'] as const;
export type AgentContextPart = (typeof AGENT_CONTEXT_PARTS)[number];

/** a todo of a direction has both ids */
export interface AgentRun {
  id: string;
  /** missing in runs started before Codex: those were claude */
  agent?: Agent;
  template: AgentTemplate;
  directionId?: string;
  todoId?: string;
  branch: string;
  title: string;
  startedAt: string;
  finishedAt?: string;
}

export interface AgentRequest {
  /** the main agent when missing */
  agent?: Agent;
  template: AgentTemplate;
  directionId?: string;
  todoId?: string;
  include: AgentContextPart[];
  extra: string;
  branch: string;
}

export interface Onboarding {
  /** when the tour was finished or closed */
  tourClosedAt?: string;
  stepsHidden?: true;
  exampleCreatedAt?: string;
  /** the first time `worklog tabs` read the Chrome tabs */
  tabsReadAt?: string;
  /** the first time every first step was done: the steps never come back after it */
  stepsDoneAt?: string;
}

export interface OnboardingPatch {
  tourClosed?: boolean;
  stepsHidden?: boolean;
  stepsDone?: boolean;
}

export interface WorklogState {
  directions: Direction[];
  todos: Todo[];
  repeats: RepeatRule[];
  linkGroups: QuickLinkGroup[];
  dailies: Daily[];
  draft: DailyDraft | null;
  notes: Note[];
  runs: AgentRun[];
  /** none in data written before onboarding: read it as {} */
  onboarding?: Onboarding;
}

// frozen: it is the shared placeholder, a consumer pushing into it would change every later default
export const EMPTY_STATE: WorklogState = frozen({
  directions: frozen([]),
  todos: frozen([]),
  repeats: frozen([]),
  linkGroups: frozen([]),
  dailies: frozen([]),
  draft: null,
  notes: frozen([]),
  runs: frozen([]),
});

function frozen<T>(value: T): T {
  Object.freeze(value);
  return value;
}

/** for `sort`: ISO stamps and dates compare as text */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** YYYY-MM-DD in local time */
export function localDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** `dd.mm hh:mm` in local time */
export function localStamp(iso: string): string {
  const date = new Date(iso);
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** the todo as its done event and the daily name it */
export function todoLabel(todo: Pick<Todo, 'text' | 'requestedBy'>): string {
  return todo.requestedBy ? `${todo.text} (от ${todo.requestedBy})` : todo.text;
}

const TICKET_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;

export function normalizeTicketKey(raw: string): string | null {
  const key = raw.trim().toUpperCase();
  return TICKET_KEY_PATTERN.test(key) ? key : null;
}

const TICKET_KEYS_IN_TEXT = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]+-\d+(?![A-Za-z0-9])/g;

/** ticket keys found in free text, also inside branch names like feature/APP-1_WEB-2; each once, in order */
export function ticketKeysIn(text: string): string[] {
  return [...new Set(text.match(TICKET_KEYS_IN_TEXT) ?? [])];
}

export function ticketFromKey(key: string, profile: Profile | null): Ticket {
  const project = profile?.projects.find(p => key.startsWith(p.prefix));
  const jira = profile?.jira;
  return { key, platform: project?.label ?? OTHER_PLATFORM, url: jira === undefined ? '' : `${jira.url}/browse/${key}` };
}

const TICKET_EXAMPLE_NUMBER = '1234';

/** ticket keys to show as examples in hints */
export function ticketKeyExamples(profile: Profile | null): string[] {
  const projects = profile?.projects ?? [];
  return projects.length === 0 ? [`ABC-${TICKET_EXAMPLE_NUMBER}`] : projects.map(p => `${p.prefix}${TICKET_EXAMPLE_NUMBER}`);
}

// --- company profile ---

export const PROFILE_VERSION = 1;

/** tickets whose key starts with `prefix` belong to the platform `label` */
export interface ProfileProject {
  prefix: string;
  label: string;
}

export interface ProfileJira {
  /** without a trailing slash */
  url: string;
  clientCert: boolean;
  segmentField?: string;
  /** status name in lower case → stage */
  stages: Record<string, Stage>;
  /** start of a status name in lower case → stage */
  stagePrefixes?: Record<string, Stage>;
  /** status name in lower case → colour of its chip */
  tones?: Record<string, JiraTone>;
}

export interface ProfileBranch {
  prefix: string;
  separator: string;
  base: string;
}

export interface ProfileEnvRow {
  replacements: [string, string][];
  /** platform label → segment → template with {b} */
  templates: Record<string, Record<string, string>>;
}

export interface ProfileEnv {
  stand?: ProfileEnvRow;
  build?: ProfileEnvRow;
  storybook?: { replacements: [string, string][]; links: { title: string; template: string }[] };
}

export interface ProfileGitlab {
  sshHost: string;
  sshPort?: number;
  mergeRequestsUrl?: string;
}

export interface ProfileLinkGroup {
  title: string;
  links: { title: string; url: string; description?: string }[];
}

export interface Profile {
  version: number;
  jira?: ProfileJira;
  projects: ProfileProject[];
  branch?: ProfileBranch;
  segments: string[];
  env?: ProfileEnv;
  gitlab?: ProfileGitlab;
  linkHosts?: { confluence?: string[]; jenkinsPrefixes?: string[] };
  links?: ProfileLinkGroup[];
}

export class ProfileError extends Error {}

type RawObject = Record<string, unknown>;

const MAX_PORT = 65535;

function profileFail(path: string, expected: string): never {
  throw new ProfileError(`${path}: ${expected}`);
}

function isRawObject(value: unknown): value is RawObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectAt(value: unknown, path: string): RawObject {
  return isRawObject(value) ? value : profileFail(path, 'нужен объект');
}

function textAt(value: unknown, path: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : profileFail(path, 'нужна непустая строка');
}

function urlAt(value: unknown, path: string): string {
  const text = textAt(value, path);
  return /^https?:\/\//.test(text) ? text : profileFail(path, 'нужен адрес https://…');
}

function templateAt(value: unknown, path: string): string {
  const text = urlAt(value, path);
  return text.includes('{b}') ? text : profileFail(path, 'в шаблоне нет {b}');
}

function listAt<T>(value: unknown, path: string, item: (value: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) return profileFail(path, 'нужен список');
  return value.map((entry: unknown, index) => item(entry, `${path}[${index}]`));
}

function recordAt<T>(value: unknown, path: string, item: (value: unknown, path: string) => T): Record<string, T> {
  return Object.fromEntries(Object.entries(objectAt(value, path)).map(([key, entry]) => [key, item(entry, `${path}["${key}"]`)]));
}

function stageAt(value: unknown, path: string): Stage {
  return STAGES.find(stage => stage === value) ?? profileFail(path, `нужен этап: ${STAGES.join(', ')}`);
}

function stagesAt(value: unknown, path: string): Record<string, Stage> {
  return Object.fromEntries(Object.entries(recordAt(value, path, stageAt)).map(([name, stage]) => [name.trim().toLowerCase(), stage]));
}

function pairAt(value: unknown, path: string): [string, string] {
  if (!Array.isArray(value) || value.length !== 2) return profileFail(path, 'нужна пара ["что", "на что"]');
  const from: unknown = value[0];
  const to: unknown = value[1];
  if (typeof from !== 'string' || typeof to !== 'string') return profileFail(path, 'нужна пара строк');
  return [from, to];
}

function toneAt(value: unknown, path: string): JiraTone {
  return JIRA_TONES.find(tone => tone === value) ?? profileFail(path, `нужен цвет: ${JIRA_TONES.join(', ')}`);
}

function tonesAt(value: unknown, path: string): Record<string, JiraTone> {
  return Object.fromEntries(Object.entries(recordAt(value, path, toneAt)).map(([name, tone]) => [name.trim().toLowerCase(), tone]));
}

function boolAt(value: unknown, path: string): boolean {
  return typeof value === 'boolean' ? value : profileFail(path, 'нужно true или false');
}

function portAt(value: unknown, path: string): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_PORT ? value : profileFail(path, 'нужен номер порта');
}

function projectAt(value: unknown, path: string): ProfileProject {
  const raw = objectAt(value, path);
  // ticket keys are upper case, hosts lower case: the profile is read the same way
  return { prefix: textAt(raw['prefix'], `${path}.prefix`).toUpperCase(), label: textAt(raw['label'], `${path}.label`) };
}

function jiraAt(value: unknown, path: string): ProfileJira {
  const raw = objectAt(value, path);
  const jira: ProfileJira = {
    url: urlAt(raw['url'], `${path}.url`).replace(/\/+$/, ''),
    clientCert: boolAt(raw['clientCert'], `${path}.clientCert`),
    stages: stagesAt(raw['stages'], `${path}.stages`),
  };
  if (raw['segmentField'] !== undefined) jira.segmentField = textAt(raw['segmentField'], `${path}.segmentField`);
  if (raw['stagePrefixes'] !== undefined) jira.stagePrefixes = stagesAt(raw['stagePrefixes'], `${path}.stagePrefixes`);
  if (raw['tones'] !== undefined) jira.tones = tonesAt(raw['tones'], `${path}.tones`);
  return jira;
}

function branchAt(value: unknown, path: string): ProfileBranch {
  const raw = objectAt(value, path);
  const separator = raw['separator'];
  if (typeof separator !== 'string') return profileFail(`${path}.separator`, 'нужна строка');
  return { prefix: textAt(raw['prefix'], `${path}.prefix`), separator, base: textAt(raw['base'], `${path}.base`) };
}

function envRowAt(value: unknown, path: string): ProfileEnvRow {
  const raw = objectAt(value, path);
  return {
    replacements: listAt(raw['replacements'], `${path}.replacements`, pairAt),
    templates: recordAt(raw['templates'], `${path}.templates`, (platform, platformPath) => recordAt(platform, platformPath, templateAt)),
  };
}

function storybookAt(value: unknown, path: string): NonNullable<ProfileEnv['storybook']> {
  const raw = objectAt(value, path);
  return {
    replacements: listAt(raw['replacements'], `${path}.replacements`, pairAt),
    links: listAt(raw['links'], `${path}.links`, (link, linkPath) => {
      const item = objectAt(link, linkPath);
      return { title: textAt(item['title'], `${linkPath}.title`), template: templateAt(item['template'], `${linkPath}.template`) };
    }),
  };
}

function envAt(value: unknown, path: string): ProfileEnv {
  const raw = objectAt(value, path);
  const env: ProfileEnv = {};
  if (raw['stand'] !== undefined) env.stand = envRowAt(raw['stand'], `${path}.stand`);
  if (raw['build'] !== undefined) env.build = envRowAt(raw['build'], `${path}.build`);
  if (raw['storybook'] !== undefined) env.storybook = storybookAt(raw['storybook'], `${path}.storybook`);
  return env;
}

function gitlabAt(value: unknown, path: string): ProfileGitlab {
  const raw = objectAt(value, path);
  const gitlab: ProfileGitlab = { sshHost: textAt(raw['sshHost'], `${path}.sshHost`) };
  if (raw['sshPort'] !== undefined) gitlab.sshPort = portAt(raw['sshPort'], `${path}.sshPort`);
  if (raw['mergeRequestsUrl'] !== undefined) gitlab.mergeRequestsUrl = urlAt(raw['mergeRequestsUrl'], `${path}.mergeRequestsUrl`).replace(/\/*$/, '/');
  return gitlab;
}

function linkHostsAt(value: unknown, path: string): NonNullable<Profile['linkHosts']> {
  const raw = objectAt(value, path);
  const hosts: NonNullable<Profile['linkHosts']> = {};
  const lower = (item: unknown, at: string): string => textAt(item, at).toLowerCase();
  if (raw['confluence'] !== undefined) hosts.confluence = listAt(raw['confluence'], `${path}.confluence`, lower);
  if (raw['jenkinsPrefixes'] !== undefined) hosts.jenkinsPrefixes = listAt(raw['jenkinsPrefixes'], `${path}.jenkinsPrefixes`, lower);
  return hosts;
}

function linkGroupAt(value: unknown, path: string): ProfileLinkGroup {
  const raw = objectAt(value, path);
  return {
    title: textAt(raw['title'], `${path}.title`),
    links: listAt(raw['links'], `${path}.links`, (link, linkPath) => {
      const item = objectAt(link, linkPath);
      const parsed: ProfileLinkGroup['links'][number] = { title: textAt(item['title'], `${linkPath}.title`), url: urlAt(item['url'], `${linkPath}.url`) };
      if (item['description'] !== undefined) parsed.description = textAt(item['description'], `${linkPath}.description`);
      return parsed;
    }),
  };
}

/** a company profile from parsed JSON; throws ProfileError naming the wrong field */
export function parseProfile(raw: unknown): Profile {
  const root = objectAt(raw, 'профиль');
  const version = root['version'];
  if (typeof version !== 'number' || !Number.isInteger(version)) return profileFail('version', 'нужно целое число');
  if (version > PROFILE_VERSION) throw new ProfileError(`профиль версии ${version}, а этот Worklog понимает версию ${PROFILE_VERSION}: обнови worklog`);
  if (version < PROFILE_VERSION) throw new ProfileError(`профиль версии ${version}, а нужна версия ${PROFILE_VERSION}: обнови профиль`);
  const profile: Profile = { version, projects: listAt(root['projects'], 'projects', projectAt), segments: listAt(root['segments'], 'segments', textAt) };
  if (root['jira'] !== undefined) profile.jira = jiraAt(root['jira'], 'jira');
  if (root['branch'] !== undefined) profile.branch = branchAt(root['branch'], 'branch');
  if (root['env'] !== undefined) profile.env = envAt(root['env'], 'env');
  if (root['gitlab'] !== undefined) profile.gitlab = gitlabAt(root['gitlab'], 'gitlab');
  if (root['linkHosts'] !== undefined) profile.linkHosts = linkHostsAt(root['linkHosts'], 'linkHosts');
  if (root['links'] !== undefined) profile.links = listAt(root['links'], 'links', linkGroupAt);
  return profile;
}

const GITLAB_USER_SLOT = '{gitlabUser}';

/** the profile's sidebar links with the GitLab login filled in; a link that needs a login it does not have is skipped */
export function profileQuickLinks(profile: Profile | null, gitlabUser: string | undefined): { groups: ProfileLinkGroup[]; skipped: string[] } {
  const skipped: string[] = [];
  const groups = (profile?.links ?? []).map(group => ({
    title: group.title,
    links: group.links.flatMap(link => {
      if (!link.url.includes(GITLAB_USER_SLOT)) return [link];
      if (gitlabUser === undefined || gitlabUser === '') {
        skipped.push(link.title);
        return [];
      }
      return [{ ...link, url: link.url.split(GITLAB_USER_SLOT).join(gitlabUser) }];
    }),
  }));
  return { groups: groups.filter(group => group.links.length > 0), skipped };
}

// --- stands, builds and Jira ---

export const ENV_ROWS = ['stand', 'build'] as const;
export type EnvRow = (typeof ENV_ROWS)[number];

export const ENV_ROW_LABELS: Record<EnvRow, string> = { stand: 'Стенд', build: 'Сборка' };

const ENV_COPY_TITLES: Record<EnvRow, string> = { stand: 'Тестовые стенды', build: 'Сборки' };

/** the colours of Jira statuses on ticket chips */
export const JIRA_TONES = ['gray', 'purple', 'blue', 'yellow', 'orange', 'cyan', 'teal', 'green'] as const;
export type JiraTone = (typeof JIRA_TONES)[number];

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function replaced(text: string, replacements: readonly (readonly [string, string])[]): string {
  return replacements.reduce((result, [from, to]) => result.split(from).join(to), text);
}

export function profileSegments(profile: Profile | null): string[] {
  return profile === null ? [] : [...profile.segments];
}

function envTemplates(platform: string, row: EnvRow, profile: Profile | null): Readonly<Record<string, string>> | undefined {
  const envRow = profile?.env?.[row];
  return envRow === undefined ? undefined : ownValue(envRow.templates, platform);
}

/** `{b}` is the branch after the row's replacements; null without a template */
export function envUrl(platform: string, row: EnvRow, segment: string, branch: string, profile: Profile | null): string | null {
  const envRow = profile?.env?.[row];
  const templates = envTemplates(platform, row, profile);
  const template = templates === undefined ? undefined : ownValue(templates, segment);
  return envRow === undefined || template === undefined ? null : template.replace('{b}', replaced(branch, envRow.replacements));
}

export function storybookLinks(branch: string, profile: Profile | null): { title: string; url: string }[] {
  const storybook = profile?.env?.storybook;
  if (storybook === undefined) return [];
  const b = replaced(branch, storybook.replacements);
  return storybook.links.map(item => ({ title: item.title, url: item.template.replace('{b}', b) }));
}

/** the profile's project labels, in its order, that have stand or build templates and a ticket here */
export function envPlatforms(tickets: readonly Ticket[], profile: Profile | null): string[] {
  if (profile === null) return [];
  return profile.projects
    .map(project => project.label)
    .filter(label => ENV_ROWS.some(row => envTemplates(label, row, profile) !== undefined) && tickets.some(t => t.platform === label));
}

/** Segment of the platform's tickets within the profile's segments; all of them while Jira has not answered or the field is empty */
export function envSegments(tickets: readonly Ticket[], platform: string, profile: Profile | null): string[] {
  const values = tickets.filter(t => t.platform === platform).flatMap(t => t.jira?.segments ?? []);
  const segments = profileSegments(profile);
  if (values.length === 0) return segments;
  return segments.filter(segment => values.includes(segment));
}

/** stands and builds of the platform as plain text, like the old generator's Plain Text; a row without templates is left out */
export function envCopyText(platform: string, segments: readonly string[], branch: string, profile: Profile | null): string {
  return ENV_ROWS.flatMap(row => {
    if (envTemplates(platform, row, profile) === undefined) return [];
    const urls = segments.flatMap(segment => envUrl(platform, row, segment, branch, profile) ?? []);
    return [[`${ENV_COPY_TITLES[row]} ${platform}:`, '', ...urls].join('\n')];
  }).join('\n\n');
}

/** the colour of a Jira status from the profile; grey when it does not say */
export function jiraTone(status: string, profile: Profile | null): JiraTone {
  const tones = profile?.jira?.tones;
  return (tones === undefined ? undefined : ownValue(tones, status.trim().toLowerCase())) ?? 'gray';
}

/** Jira's own case varies: the name is matched in lower case, then by its start */
export function stageOfJiraStatus(jiraStatus: string, jira: ProfileJira): Stage | null {
  const name = jiraStatus.trim().toLowerCase();
  return ownValue(jira.stages, name) ?? Object.entries(jira.stagePrefixes ?? {}).find(([start]) => name.startsWith(start))?.[1] ?? null;
}

function ownJiraStage(ticket: Ticket, jira: ProfileJira): Stage | null {
  return ticket.jira === undefined ? null : stageOfJiraStatus(ticket.jira.status, jira);
}

/** the most behind stage of the tickets of the profile's projects; `current` instead of done while one of them is not known; null when Jira leads none */
export function jiraStage(tickets: readonly Ticket[], current: Stage, profile: Profile | null): Stage | null {
  const jira = profile?.jira;
  if (profile === null || jira === undefined) return null;
  const labels = profile.projects.map(project => project.label);
  const own = tickets.filter(t => labels.includes(t.platform));
  const known = own.flatMap(t => {
    const stage = ownJiraStage(t, jira);
    return stage === null ? [] : [STAGES.indexOf(stage)];
  });
  if (known.length === 0) return null;
  const stage = STAGES[Math.min(...known)];
  return stage === 'done' && known.length < own.length ? current : stage;
}

export function directionStage(direction: Direction): Stage {
  return direction.stage ?? stageOf(direction.status) ?? 'in_progress';
}

export function isJiraLed(direction: Direction): boolean {
  return direction.stageFromJira === true;
}

export type DropIntent = 'move' | 'unmark';

/** what dropping the direction on a column means; null when the column does not take it */
export function dropIntent(direction: Direction, target: Status): DropIntent | null {
  if (!isJiraLed(direction) || markOf(target) !== null || target === direction.status) return 'move';
  return markOf(direction.status) === null ? null : 'unmark';
}

/** the tickets Jira is asked about: those of unfinished directions, each once */
export function jiraTicketKeys(directions: readonly Direction[]): string[] {
  return [...new Set(ownDirections(directions).filter(d => d.status !== 'done').flatMap(d => d.tickets.map(t => t.key)))];
}

export function isExample(direction: Direction): boolean {
  return direction.example === true;
}

/** the user's own directions: without the onboarding example */
export function ownDirections(directions: readonly Direction[]): Direction[] {
  return directions.filter(direction => !isExample(direction));
}

const DAY_MS = 86_400_000;

/** the onboarding example: invented work with fake tickets, links, events, a todo and a note */
export function exampleData(profile: Profile | null, at: string, newId: () => string): { direction: Direction; todo: Todo; note: Note } {
  const before = (days: number): string => new Date(Date.parse(at) - days * DAY_MS).toISOString();
  const projects = profile?.projects ?? [];
  const first = projects[0]?.prefix ?? 'PROJ-';
  const second = projects[1]?.prefix ?? first;
  // no url: a fake key must not open Jira
  const tickets = [`${first}1001`, `${second}1002`].map(key => ({ ...ticketFromKey(key, profile), url: '' }));
  const id = newId();
  const event = (days: number, text: string): WorkEvent => ({ id: newId(), at: before(days), text, source: 'manual', kind: 'note' });
  const direction: Direction = {
    id,
    title: 'Пример: капча на входе',
    status: 'in_progress',
    stage: 'in_progress',
    example: true,
    tickets,
    links: [
      { title: 'Макет', url: 'https://www.figma.com/design/example/captcha', kind: 'figma', description: 'Экраны капчи для всех платформ' },
      { title: 'BRD', url: 'https://wiki.example.com/pages/viewpage.action?pageId=1001', kind: 'confluence', description: 'Требования: капча после трёх неудачных входов' },
      { title: 'Swagger', url: 'https://api.example.com/swagger', kind: 'other' },
      { title: 'MR !1', url: 'https://git.example.com/team/app/-/merge_requests/1', kind: 'mr' },
    ],
    events: [
      event(3, 'Разобрал BRD, задал аналитику вопросы по лимиту попыток входа'),
      event(2, 'Сверстал виджет капчи, жду от дизайнера текст ошибки'),
      event(1, 'Так выглядит лента: сюда попадает всё, что вы рассказываете агенту, например «запиши в worklog по капче: бэк поправил редирект»'),
    ],
    order: 0,
    createdAt: before(3),
    updatedAt: at,
  };
  const todo: Todo = { id: newId(), text: 'Уточнить у дизайнера текст ошибки капчи', directionId: id, requestedBy: 'Ани', done: false, createdAt: before(2) };
  const note: Note = {
    id: newId(),
    title: 'Ключ капчи на стендах',
    body: 'На стендах ключ сайта берётся из конфига стенда, на проде — из переменной окружения.',
    directionIds: [id],
    files: [],
    urls: [{ url: 'https://wiki.example.com/pages/viewpage.action?pageId=1002', title: 'Настройки капчи' }],
    createdAt: before(1),
    updatedAt: before(1),
  };
  return { direction, todo, note };
}

export const FIRST_STEPS = ['direction', 'tabs', 'event', 'todo'] as const;
export type FirstStep = (typeof FIRST_STEPS)[number];

/** what the user has done of the first steps; the example does not count */
export function firstStepsDone(state: WorklogState): Record<FirstStep, boolean> {
  const own = ownDirections(state.directions);
  const examples = new Set(state.directions.filter(isExample).map(direction => direction.id));
  return {
    direction: own.length > 0,
    tabs: state.onboarding?.tabsReadAt !== undefined,
    event: own.some(direction => direction.events.some(e => e.source === 'manual' || e.source === 'claude')),
    todo: state.todos.some(todo => todo.directionId === undefined || !examples.has(todo.directionId)),
  };
}

export interface OnboardingPrompts {
  direction: string;
  event: string;
  link: string;
  todo: string;
  repeat: string;
  tabs: string;
}

/** phrases to hand the agent, with the company's ticket prefixes and the user's own direction when there is one */
export function onboardingPrompts(profile: Profile | null, directions: readonly Direction[]): OnboardingPrompts {
  const projects = profile?.projects ?? [];
  const first = projects[0]?.prefix ?? 'PROJ-';
  const second = projects[1]?.prefix ?? first;
  const named = ownDirections(directions)
    .filter(direction => direction.status !== 'done')
    .sort((a, b) => a.order - b.order)[0];
  // the title stays as written: it does not decline after «по»
  const about = named === undefined ? 'по капче' : `по направлению «${named.title}»`;
  const to = named === undefined ? 'к капче' : `к направлению «${named.title}»`;
  return {
    direction: `заведи в worklog направление по задачам ${first}1234 и ${second}567`,
    event: `запиши в worklog ${about}: бэк поправил редирект, жду стенд`,
    link: `добавь в worklog ${to} ссылку на макет: <ссылка>`,
    todo: 'добавь в worklog дело: завести задачу на бэк, просил аналитик',
    repeat: 'добавь в worklog повторяющееся дело: дейлик каждый будний день в 11:30',
    tabs: 'разбери вкладки chrome в worklog',
  };
}

const MERGE_REQUEST_NUMBER = /\/merge_requests\/(\d+)(?:[/?#]|$)/;

/** null without the project's merge requests address in the profile */
export function mergeRequestUrl(id: number, profile: Profile | null): string | null {
  const base = profile?.gitlab?.mergeRequestsUrl;
  return base === undefined ? null : `${base}${id}`;
}

/** the MR a link points to, its diffs and commits pages too */
export function mergeRequestNumber(url: string): number | null {
  const match = MERGE_REQUEST_NUMBER.exec(url);
  return match === null ? null : Number(match[1]);
}

/** a direction's MRs in the order they were linked, each once, opening the page its first link opens */
export function mergeRequestsOf(links: readonly Link[]): { id: number; url: string }[] {
  const found = new Map<number, string>();
  for (const link of links) {
    const id = mergeRequestNumber(link.url);
    if (id !== null && !found.has(id)) found.set(id, link.url);
  }
  return [...found].map(([id, url]) => ({ id, url }));
}

export const JIRA_STATES = ['off', 'ok', 'error'] as const;
export type JiraState = (typeof JIRA_STATES)[number];

export interface JiraHealth {
  state: JiraState;
  message: string | null;
  /** the last successful poll, ISO */
  checkedAt: string | null;
  polling: boolean;
}

// `host:port` also looks like `scheme:`, so only `scheme://` and the schemes without slashes below count
const HAS_SCHEME = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|tel:)/i;

/** a bare host would become a link relative to the app itself */
export function withScheme(address: string): string {
  return HAS_SCHEME.test(address) ? address : `https://${address}`;
}

export function detectLinkKind(url: string, profile: Profile | null): LinkKind {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'other';
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'figma.com' || host.endsWith('.figma.com')) return 'figma';
  if (profile?.linkHosts?.confluence?.includes(host) === true) return 'confluence';
  if (parsed.pathname.includes('/merge_requests/')) return 'mr';
  if (profile?.linkHosts?.jenkinsPrefixes?.some(prefix => host.startsWith(prefix)) === true) return 'jenkins';
  if (parsed.pathname.includes('/-/tree/')) return 'branch';
  return 'other';
}

/** an index inside a list of `length` items; 0 for an empty list */
export function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, length - 1));
}

export function moveInList<T>(list: readonly T[], from: number, to: number): T[] {
  const result = [...list];
  if (from < 0 || from >= list.length) return result;
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}

function renumber(directions: Direction[]): Direction[] {
  return directions.map((direction, order) => (direction.order === order ? direction : { ...direction, order }));
}

function inStatusOrder(directions: readonly Direction[], status: Status): Direction[] {
  return directions.filter(d => d.status === status).sort((a, b) => a.order - b.order);
}

export function placeDirection(directions: Direction[], id: string, status: Status, index: number): Direction[] {
  const moved = directions.find(d => d.id === id);
  if (!moved) return directions;

  const oldStatus = moved.status;
  const target = inStatusOrder(directions, status).filter(d => d.id !== id);
  const position = Math.max(0, Math.min(index, target.length));
  target.splice(position, 0, { ...moved, status });

  const renumbered = new Map<string, Direction>();
  for (const direction of renumber(target)) renumbered.set(direction.id, direction);
  if (oldStatus !== status) {
    const source = inStatusOrder(directions, oldStatus).filter(d => d.id !== id);
    for (const direction of renumber(source)) renumbered.set(direction.id, direction);
  }

  return directions.map(d => renumbered.get(d.id) ?? d);
}

const SATURDAY = 6;
const SUNDAY = 0;

function isWorkday(date: Date): boolean {
  const day = date.getDay();
  return day !== SATURDAY && day !== SUNDAY;
}

function dailyTimeOn(date: Date, dayShift: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayShift, DAILY_HOUR, DAILY_MINUTE);
}

export function defaultPeriodStart(now: Date): Date {
  let shift = -1;
  while (!isWorkday(dailyTimeOn(now, shift))) shift--;
  return dailyTimeOn(now, shift);
}

/** the last held daily starts the period, unless it was before the previous working day */
export function currentPeriodStart(now: Date, dailies: readonly Daily[]): string {
  const fallback = defaultPeriodStart(now);
  const earliestHeld = new Date(fallback.getFullYear(), fallback.getMonth(), fallback.getDate()).toISOString();
  const nowIso = now.toISOString();
  let held: string | null = null;
  for (const daily of dailies) {
    if (daily.heldAt <= nowIso && (held === null || daily.heldAt > held)) held = daily.heldAt;
  }
  return held !== null && held >= earliestHeld ? held : fallback.toISOString();
}

/** today's daily, or the next working day's once today's is held */
export function upcomingDailyAt(now: Date, dailies: readonly Daily[] = []): Date {
  const today = dailyTimeOn(now, 0);
  const heldToday = dailies.some(d => {
    const held = new Date(d.heldAt);
    return held <= now && held.getFullYear() === today.getFullYear() && held.getMonth() === today.getMonth() && held.getDate() === today.getDate();
  });
  let shift = heldToday ? 1 : 0;
  while (!isWorkday(dailyTimeOn(now, shift))) shift++;
  return dailyTimeOn(now, shift);
}

export function activeDraft(state: WorklogState, periodStart: string): DailyDraft | null {
  return state.draft !== null && state.draft.periodStart === periodStart ? state.draft : null;
}

export function summaryRunState(run: SummaryRun | null, now: Date): 'idle' | 'running' | 'failed' {
  if (run === null) return 'idle';
  if (run.status === 'failed') return 'failed';
  return now.getTime() - new Date(run.startedAt).getTime() > SUMMARY_STALE_MS ? 'failed' : 'running';
}

export const UPDATE_CHECKS = ['none', 'available', 'local-changes'] as const;
/** what the window learns about a newer Worklog on GitHub */
export type UpdateCheck = (typeof UPDATE_CHECKS)[number];
/** the result of a check asked for by the user: also when GitHub could not be reached */
export type UpdateCheckResult = UpdateCheck | 'unreachable';

/** the clone against its tracked branch */
export interface UpdateFacts {
  ahead: number;
  behind: number;
  dirty: boolean;
}

export const UPDATE_PHASES = ['running', 'done', 'failed'] as const;
export type UpdatePhase = (typeof UPDATE_PHASES)[number];

export interface UpdateRun {
  phase: UpdatePhase;
  startedAt: string;
  finishedAt?: string;
  /** why it failed, a lowercase clause for «Не удалось обновить Worklog: …» */
  error?: string;
  /** the new version had written data, and the data came back from the snapshot */
  dataRestored?: true;
  /** the process doing the update: while it lives the update runs, however long */
  pid?: number;
}

export interface UpdateStatus {
  check: UpdateCheck;
  /** the code the server runs, a short commit hash; null outside git */
  version: string | null;
  run: UpdateRun | null;
}

export const UPDATE_CHECK_MS = 6 * 60 * 60_000;
export const UPDATE_STALE_MS = 15 * 60_000;
export const UPDATE_HEALTH_MS = 30_000;

/** local commits or edits keep the button from touching the clone */
export function updateCheckOf(facts: UpdateFacts | null): UpdateCheck {
  if (facts === null || facts.behind === 0) return 'none';
  return facts.ahead > 0 || facts.dirty ? 'local-changes' : 'available';
}

/** a run read back from its file; a running one whose process is gone, or without a process and too old, was interrupted */
export function parseUpdateRun(raw: unknown, now: Date, alive: (pid: number) => boolean = () => false): UpdateRun | null {
  if (typeof raw !== 'object' || raw === null || !('phase' in raw) || !('startedAt' in raw)) return null;
  const phase = UPDATE_PHASES.find(item => item === raw.phase);
  const startedAt = raw.startedAt;
  if (phase === undefined || typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt))) return null;
  const run: UpdateRun = { phase, startedAt };
  if ('finishedAt' in raw && typeof raw.finishedAt === 'string') run.finishedAt = raw.finishedAt;
  if ('error' in raw && typeof raw.error === 'string') run.error = raw.error;
  if ('dataRestored' in raw && raw.dataRestored === true) run.dataRestored = true;
  if ('pid' in raw && typeof raw.pid === 'number' && Number.isInteger(raw.pid)) run.pid = raw.pid;
  if (phase !== 'running') return run;
  const over = run.pid === undefined ? now.getTime() - Date.parse(startedAt) > UPDATE_STALE_MS : !alive(run.pid);
  return over ? { phase: 'failed', startedAt, error: 'обновление прервалось' } : run;
}

export function updateFailureText(run: UpdateRun): string {
  const left = run.dataRestored === true ? 'данные возвращены из снимка перед обновлением' : 'данные не тронуты';
  return `Не удалось обновить Worklog: ${run.error ?? 'причина неизвестна'}. Осталась прежняя версия, ${left}.`;
}

const STATUS_EVENT_PREFIX = 'Статус: ';

export function statusOfEvent(event: WorkEvent): Status | null {
  if (event.kind !== 'status') return null;
  return (
    STATUSES.find(status => {
      const head = STATUS_EVENT_PREFIX + STATUS_LABELS[status];
      return event.text === head || event.text.startsWith(`${head} · `);
    }) ?? null
  );
}

/** when a done direction was done; older data without `doneAt` falls back to its last «Статус: Готово», then `updatedAt` */
export function doneDateOf(direction: Direction): string {
  if (direction.doneAt !== undefined) return direction.doneAt;
  const done = direction.events.filter(e => statusOfEvent(e) === 'done').sort(byTime).at(-1);
  return done?.at ?? direction.updatedAt;
}

export interface DigestGroup {
  direction: Direction;
  events: WorkEvent[];
  items: SummaryItem[];
}

export interface WaitingEntry {
  direction: Direction;
  since: string;
}

export interface PeriodDigest {
  groups: DigestGroup[];
  unbound: SummaryItem[];
  waiting: WaitingEntry[];
  today: { directions: Direction[]; todos: Todo[] };
  eventCount: number;
}

function byTime<T extends { at: string }>(a: T, b: T): number {
  return compareText(a.at, b.at);
}

function firstActivity(group: DigestGroup): string {
  const times = [...group.events, ...group.items].map(x => x.at).sort();
  return times[0] ?? '';
}

function waitingSince(direction: Direction): string {
  const entered = direction.events.filter(e => statusOfEvent(e) === 'waiting').sort(byTime).at(-1);
  return entered?.at ?? direction.updatedAt;
}

/** `today` is the local date, YYYY-MM-DD */
export function periodDigest(state: WorklogState, periodStart: string, summary: SessionSummary | null, today: string): PeriodDigest {
  // the onboarding example never reaches the daily
  const directions = ownDirections(state.directions);
  const examples = new Set(state.directions.filter(isExample).map(d => d.id));
  const known = new Set(directions.map(d => d.id));
  const items = summary?.items ?? [];
  const groups: DigestGroup[] = [];
  let eventCount = 0;
  for (const direction of directions) {
    const events = direction.events.filter(e => e.at >= periodStart).sort(byTime);
    const own = items.filter(item => item.directionId === direction.id).sort(byTime);
    eventCount += events.length;
    if (events.length > 0 || own.length > 0) groups.push({ direction, events, items: own });
  }
  groups.sort((a, b) => compareText(firstActivity(a), firstActivity(b)));
  const grouped = new Set(groups.map(g => g.direction.id));
  const waiting = directions
    .filter(d => d.status === 'waiting')
    .map(direction => ({ direction, since: waitingSince(direction) }))
    .sort((a, b) => compareText(a.since, b.since));
  return {
    groups,
    unbound: items.filter(item => item.directionId === null || !known.has(item.directionId)),
    waiting,
    today: {
      directions: directions.filter(d => d.status === 'in_progress' && !grouped.has(d.id)).sort((a, b) => a.order - b.order),
      // repeating todos are routine, not news for the daily
      todos: state.todos.filter(t => !t.done && t.repeatId === undefined && t.due !== undefined && t.due <= today && (t.directionId === undefined || !examples.has(t.directionId))),
    },
    eventCount,
  };
}

export function dailyItems(digest: PeriodDigest): DailyItem[] {
  const result: DailyItem[] = [];
  for (const { direction, events, items } of digest.groups) {
    const bound = { directionId: direction.id, directionTitle: direction.title };
    for (const e of events) result.push({ ...bound, text: e.text, origin: 'event', eventSource: e.source });
    for (const item of items) result.push({ ...bound, text: item.text, origin: 'summary' });
  }
  for (const item of digest.unbound) result.push({ directionId: null, directionTitle: null, text: item.text, origin: 'summary' });
  return result;
}

export function countEventsAfter(state: WorklogState, periodStart: string, after: string): number {
  let count = 0;
  for (const direction of ownDirections(state.directions)) {
    for (const e of direction.events) if (e.at >= periodStart && e.at > after) count++;
  }
  return count;
}

const STATUS_PHRASES: Record<Status, string> = {
  in_progress: 'Взял в работу',
  waiting: 'Жду',
  in_review: 'Отправил мерж реквест на ревью',
  testing: 'Передал в тестирование',
  awaiting_release: 'Жду релиза',
  parked: 'Отложил',
  done: 'Закрыл',
};

function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? upperFirst(trimmed) : `${upperFirst(trimmed)}.`;
}

/** a stage change made in Jira: someone else may have made it, so no first person */
const JIRA_STAGE_PHRASES: Record<Stage, string> = {
  in_progress: 'Вернулась в работу',
  in_review: 'Ушла на код-ревью',
  testing: 'Ушла в тестирование',
  awaiting_release: 'Ждёт релиза',
  done: 'Закрыта',
};

export function markClearedText(mark: Mark, waitingFor: string | undefined): string {
  if (mark === 'parked') return 'Вернул из отложенных';
  return waitingFor === undefined ? 'Больше не жду' : `Больше не жду: ${waitingFor}`;
}

export function eventSentence(event: WorkEvent): string {
  if (event.kind === 'todo-done') return `Сделал: ${lowerFirst(event.text)}`;
  const status = statusOfEvent(event);
  if (status === null) return event.text;
  const stage = event.source === 'jira' ? stageOf(status) : null;
  if (stage !== null) return JIRA_STAGE_PHRASES[stage];
  const detail = event.text.split(' · ').slice(1).join(' · ');
  return status === 'waiting' && detail !== '' ? `Жду: ${detail}` : STATUS_PHRASES[status];
}

function ticketLine(direction: Direction): string | null {
  if (direction.tickets.length === 0) return null;
  return direction.tickets.map((ticket, index) => `${index + 1}. ${ticket.key}`).join('  ');
}

function groupParagraph({ direction, events, items }: DigestGroup): string {
  const onlyTaken = items.length === 0 && events.length === 1 && events[0].source !== 'jira' && statusOfEvent(events[0]) === 'in_progress';
  const body = onlyTaken
    ? `Взял в работу задачу «${direction.title}».`
    : `Касаемо задачи «${direction.title}»: ${[...events.map(eventSentence), ...items.map(item => item.text)].map(sentence).join(' ')}`;
  const tickets = ticketLine(direction);
  return tickets === null ? body : `${body}\n${tickets}`;
}

function todayParagraph(today: PeriodDigest['today']): string | null {
  const parts = [
    ...today.directions.map(d => `продолжаю задачу «${d.title}»`),
    ...today.todos.map(t => lowerFirst(todoLabel(t))),
  ];
  return parts.length === 0 ? null : `Сегодня: ${parts.join('; ')}.`;
}

export function templateText(digest: PeriodDigest): string {
  const paragraphs = digest.groups.map(groupParagraph);
  const today = todayParagraph(digest.today);
  if (today !== null) paragraphs.push(today);
  return paragraphs.join('\n\n');
}

// «юзер-агент» is not about AI: a word after a hyphen does not count
const AI_WORDS = /(?<![\p{L}\p{N}]|[\p{L}\p{N}]-)(claude|ai|llm|gpt|ии|(?:клод|агент|нейросет|сесси|сгенерир|ассистент)\p{L}*)(?![\p{L}\p{N}])/giu;

/** words that give away AI in a text meant for other people */
export function findAiMentions(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(AI_WORDS)) {
    const word = match[1].toLowerCase();
    if (!found.includes(word)) found.push(word);
  }
  return found;
}

const WEB_ADDRESS = /^https?:\/\//i;
const FILE_LINE = /^(.+?):(\d+)$/;

export type NoteLink = { file: NoteFile } | { url: NoteUrl };

/** `path`, `path:42`, or `https://… title`; a path may not leave the code root */
export function parseNoteLink(raw: string): NoteLink | null {
  const text = raw.trim();
  if (text === '') return null;
  if (WEB_ADDRESS.test(text)) {
    const space = text.search(/\s/);
    if (space === -1) return { url: { url: text } };
    const title = text.slice(space).trim();
    return { url: { url: text.slice(0, space), title } };
  }
  const match = FILE_LINE.exec(text);
  const filePath = (match ? match[1] : text).trim().replace(/^\.\//, '');
  const line = match ? Number(match[2]) : undefined;
  if (!isSafeRelativePath(filePath) || line === 0) return null;
  return { file: line === undefined ? { path: filePath } : { path: filePath, line } };
}

export function isSafeRelativePath(filePath: string): boolean {
  if (filePath === '' || filePath.startsWith('/') || filePath.startsWith('~') || /\s/.test(filePath)) return false;
  return filePath.split('/').every(part => part !== '' && part !== '..' && part !== '.');
}

export function fileLabel(file: NoteFile): string {
  return file.line === undefined ? file.path : `${file.path}:${file.line}`;
}

/** the note's links as the lines `parseNoteLink` reads back: files first */
export function noteLinkLines(note: Pick<Note, 'files' | 'urls'>): string[] {
  return [...note.files.map(fileLabel), ...note.urls.map(u => (u.title ? `${u.url} ${u.title}` : u.url))];
}

/** every word of the query is in the note: title, body, links, or the titles and tickets of its directions */
export function noteMatches(note: Note, query: string, directions: readonly Direction[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(word => word !== '');
  if (words.length === 0) return true;
  const attached = directions.filter(d => note.directionIds.includes(d.id));
  const haystack = [
    note.title,
    note.body,
    ...noteLinkLines(note),
    ...attached.flatMap(d => [d.title, ...d.tickets.map(t => t.key)]),
  ]
    .join('\n')
    .toLowerCase();
  return words.every(word => haystack.includes(word));
}

/** coding agents Worklog works with: skills, session summaries, handing tasks over */
export const AGENTS = ['claude', 'codex'] as const;
export type Agent = (typeof AGENTS)[number];
export const AGENT_LABELS: Record<Agent, string> = { claude: 'Claude', codex: 'Codex' };

/** where a code file opens on its line */
export const EDITORS = ['jetbrains', 'vscode', 'cursor'] as const;
export type Editor = (typeof EDITORS)[number];

/** where the agent's session opens */
export const TERMINALS = ['warp', 'iterm', 'terminal'] as const;
export type Terminal = (typeof TERMINALS)[number];

export const TERMINAL_OPEN_LABELS: Record<Terminal, string> = { warp: 'новая вкладка Warp', iterm: 'новая вкладка iTerm2', terminal: 'новое окно Терминала' };

export const DEFAULT_BASE_BRANCH = 'main';

export function baseBranch(profile: Profile | null): string {
  return profile?.branch?.base ?? DEFAULT_BASE_BRANCH;
}

/** where a branch exists: in the code root, only in origin, nowhere */
export const BRANCH_PLACES = ['local', 'remote', 'none'] as const;
export type BranchPlace = (typeof BRANCH_PLACES)[number];
const AGENT_RECENT_EVENTS = 5;
/** the one form of the CLI path, so one permission rule covers every call */
const WORKLOG_CLI = '~/.local/bin/worklog';

const BRANCHLESS_TEMPLATES: readonly AgentTemplate[] = ['question', 'docs', 'tabs'];

/** the first ticket of each profile project, in the profile's order, joined by its branch format; other tickets never make a branch */
export function directionBranch(tickets: readonly Ticket[], profile: Profile | null): string | null {
  const branch = profile?.branch;
  if (profile === null || branch === undefined) return null;
  const keys = profile.projects.flatMap(project => tickets.find(t => t.platform === project.label)?.key ?? []);
  return keys.length === 0 ? null : `${branch.prefix}${keys.join(branch.separator)}`;
}

/** the direction's branch; questions, reading docs and directions without one stay on the base branch */
export function suggestBranch(tickets: readonly Ticket[], template: AgentTemplate, profile: Profile | null): string {
  if (BRANCHLESS_TEMPLATES.includes(template)) return baseBranch(profile);
  return directionBranch(tickets, profile) ?? baseBranch(profile);
}

const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** a subset of git's rules that is safe to put into a shell command unquoted */
export function isBranchName(name: string): boolean {
  return BRANCH_NAME.test(name) && !name.includes('..') && !name.includes('//') && !name.endsWith('/') && !name.endsWith('.') && !name.endsWith('.lock');
}

export function activeRuns(runs: readonly AgentRun[]): AgentRun[] {
  return runs.filter(run => run.finishedAt === undefined).sort((a, b) => compareText(a.startedAt, b.startedAt));
}

export interface AgentContext {
  direction: Direction | undefined;
  todo: Todo | undefined;
  tickets: Ticket[];
  links: Link[];
  /** newest last */
  events: WorkEvent[];
  /** open todos of the direction, without the todo the task is about */
  todos: Todo[];
  notes: Note[];
}

/** what a task about the direction or the todo can take along; a todo brings its direction's context */
export function agentContext(state: WorklogState, target: { directionId?: string; todoId?: string }): AgentContext {
  const todo = target.todoId === undefined ? undefined : state.todos.find(t => t.id === target.todoId);
  const directionId = target.directionId ?? todo?.directionId;
  const direction = directionId === undefined ? undefined : state.directions.find(d => d.id === directionId);
  if (direction === undefined) return { direction, todo, tickets: [], links: [], events: [], todos: [], notes: [] };
  return {
    direction,
    todo,
    tickets: direction.tickets,
    links: direction.links,
    events: [...direction.events].sort(byTime).slice(-AGENT_RECENT_EVENTS),
    todos: state.todos.filter(t => t.directionId === direction.id && !t.done && t.id !== todo?.id),
    notes: state.notes.filter(n => n.directionIds.includes(direction.id)),
  };
}

export function agentRunTitle(context: Pick<AgentContext, 'direction' | 'todo'>, template: AgentTemplate): string {
  const subject = context.todo?.text ?? context.direction?.title ?? 'Worklog';
  return `${subject} · ${AGENT_TEMPLATE_LABELS[template].toLowerCase()}`;
}

const TEMPLATE_TASKS: Record<AgentTemplate, string> = {
  execute: 'Выполни задачу.',
  decompose: 'Декомпозируй задачу на дела: небольшие самостоятельные шаги. Код не меняй. Покажи список, а после моего подтверждения запиши дела в Worklog.',
  docs: 'Изучи документацию по задаче: тикеты, Confluence, макеты и то, на что они ссылаются. Код не меняй. Собери полезные ссылки с коротким описанием каждой и после моего подтверждения запиши их в Worklog.',
  question: 'Ответь на вопрос из дополнительного контекста. Код не меняй.',
  custom: 'Сделай то, что описано в дополнительном контексте.',
  tabs: 'Разбери открытые вкладки Chrome в Worklog по скиллу worklog-chrome-tabs. Код не меняй.',
};

function indented(text: string): string {
  return text
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n');
}

function todoDetails(todo: Todo): string {
  const details = [todo.requestedBy === undefined ? null : `просил ${todo.requestedBy}`, todo.due === undefined ? null : `срок ${todo.due}`].filter(d => d !== null);
  return details.length === 0 ? `«${todo.text}»` : `«${todo.text}» (${details.join(', ')})`;
}

function contextSections(context: AgentContext, include: readonly AgentContextPart[]): string[] {
  const sections: string[] = [];
  const wants = (part: AgentContextPart, length: number): boolean => include.includes(part) && length > 0;
  if (wants('tickets', context.tickets.length)) {
    sections.push(`## Тикеты\nОткрой их сам.\n${context.tickets.map(t => `- ${t.key}${t.platform === 'other' ? '' : ` (${t.platform})`}: ${t.url}`).join('\n')}`);
  }
  if (wants('links', context.links.length)) {
    const lines = context.links.map(l => (l.description === undefined ? `- ${l.title}: ${l.url}` : `- ${l.title}: ${l.url}\n${indented(l.description)}`));
    sections.push(`## Ссылки\n${lines.join('\n')}`);
  }
  if (wants('events', context.events.length)) {
    sections.push(`## Последние события\n${context.events.map(e => `- ${localStamp(e.at)} ${e.text}`).join('\n')}`);
  }
  if (wants('todos', context.todos.length)) {
    sections.push(`## Открытые дела направления\n${context.todos.map(t => `- ${todoDetails(t)}`).join('\n')}`);
  }
  if (wants('notes', context.notes.length)) {
    const notes = context.notes.map(note => {
      const links = noteLinkLines(note);
      return [`### ${note.title}`, note.body, links.length === 0 ? '' : `Ссылки: ${links.join('; ')}`].filter(part => part !== '').join('\n');
    });
    sections.push(`## Заметки базы знаний\nПути к файлам — от корня репозитория.\n\n${notes.join('\n\n')}`);
  }
  return sections;
}

function branchRule(branch: string, base: string): string {
  const head = 'Первым шагом проверь `git status`: если в рабочей копии есть незакоммиченные изменения, остановись и спроси меня — ничего не прячь и не откатывай сам.';
  if (branch === base) return `${head} Затем переключись на \`${base}\`.`;
  return `${head} Затем переключись на ветку \`${branch}\`; если её нет ни локально, ни в origin — \`git fetch origin ${base}\` и создай её от \`origin/${base}\`.`;
}

/** the starting prompt of the agent's session */
export function agentPrompt(state: WorklogState, request: AgentRequest, runId: string, profile: Profile | null): string {
  const context = agentContext(state, request);
  const { direction, todo } = context;
  const task = [`# Задание\n${TEMPLATE_TASKS[request.template]}`];
  if (todo !== undefined) task.push(`Дело: ${todoDetails(todo)}.`);
  if (direction !== undefined) {
    const waiting = direction.status === 'waiting' && direction.waitingFor !== undefined ? `, жду: ${direction.waitingFor}` : '';
    const stage = markOf(direction.status) === null ? '' : `, этап «${STATUS_LABELS[directionStage(direction)]}»`;
    task.push(`Направление в Worklog: «${direction.title}» (id ${direction.id}), статус «${STATUS_LABELS[direction.status]}»${waiting}${stage}.`);
  }
  const extra = request.extra.trim();
  const parts = [task.join('\n'), ...contextSections(context, request.include)];
  if (extra !== '') parts.push(`## Дополнительный контекст\n${extra}`);

  const dirFlag = direction === undefined ? '' : ` (к направлению — \`--dir ${direction.id}\`)`;
  const gitRules = DIRECTIONLESS_TEMPLATES.includes(request.template) ? [] : [branchRule(request.branch, baseBranch(profile)), 'Коммить и пушь только когда я попрошу в этой сессии.'];
  const rules = [
    ...gitRules,
    ...(direction === undefined ? [] : [`Перед работой посмотри заметки базы знаний по направлению: \`${WORKLOG_CLI} note list --dir ${direction.id}\`.`]),
    `Результаты — дела, ссылки, заметки, событие о сделанном — записывай в Worklog через \`${WORKLOG_CLI}\`${dirFlag} по скиллам worklog-update и worklog-notes. Каждый раз сначала покажи, что запишешь, и дождись моего подтверждения. Тексты — от первого лица единственного числа, без упоминаний ИИ, Claude, агента и сессии.`,
    `Когда работа закончена или я скажу, что закончили, выполни \`${WORKLOG_CLI} agent done ${runId}\`.`,
  ];
  parts.push(`# Правила\n${rules.map((rule, i) => `${i + 1}. ${rule}`).join('\n')}`);
  return `${parts.join('\n\n')}\n`;
}
