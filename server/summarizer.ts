import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Agent, Direction, PeriodDigest, SessionSummary, SummaryItem, TodoCandidate } from '../shared/model.ts';
import { STATUS_LABELS, eventSentence, localStamp, todoLabel } from '../shared/model.ts';
import { isErrorCode } from './fs-utils.ts';
import { isRecord } from './guards.ts';
import type { PreparedSession } from './sessions.ts';
import { SUMMARY_MARKER } from './sessions.ts';
import { newId } from './store.ts';

const MAX_ITEMS = 3;
const STDERR_TAIL = 300;
const MS_PER_SECOND = 1000;

const NULLABLE_STRING = { type: ['string', 'null'] };

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sessions', 'todoCandidates', 'prose'],
  properties: {
    sessions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId', 'directionId', 'items'],
        properties: {
          sessionId: { type: 'string' },
          directionId: NULLABLE_STRING,
          items: { type: 'array', maxItems: MAX_ITEMS, items: { type: 'string' } },
        },
      },
    },
    todoCandidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId', 'text', 'requestedBy', 'directionId'],
        properties: {
          sessionId: { type: 'string' },
          text: { type: 'string' },
          requestedBy: NULLABLE_STRING,
          directionId: NULLABLE_STRING,
        },
      },
    },
    prose: { type: 'string' },
  },
} as const;

const INSTRUCTIONS = `Во всех текстах (items, todoCandidates, prose) — никаких упоминаний помощника, ИИ, Claude, агентов, сессий, переписки, генерации: всё сделал он сам.

sessions — по одной записи на каждую сессию из входа, sessionId как во входе:
- items — от 1 до 3 коротких пунктов «что сделал» от первого лица единственного числа, в прошедшем времени («разобрал…», «поправил…», «выяснил…»). Только то, что в переписке действительно сделано или выяснено. Не пересказывай вопросы, планы и недоделанное. Не повторяй то, что уже есть в событиях периода. Нет рабочего результата — пустой список.
- directionId — id направления из списка, если сессия явно про него: совпадают номера задач, ветка вида feature/APP-12_WEB-34 или тема. У каждой сессии есть подсказка по номерам задач. Не уверен — null.

todoCandidates — просьбы коллег и его обещания, которые в переписке упомянуты, но не выполнены («Иван попросил завести задачу на бэк»). text — что сделать, в повелительном наклонении («Завести задачу бэку на фикс поиска»). requestedBy — кто попросил, в родительном падеже («Ивана»), или null. Нет явной просьбы или обещания — нет кандидата.

prose — текст, который он прочитает на дейлике:
- от первого лица единственного числа; никогда не упоминай помощника, ИИ, Claude, агентов, сессии, переписку, генерацию — всё сделал он сам;
- без «мы»: «договорился», «завёл», а не «договорились», «заведём»;
- события с пометкой [Jira] сделал не он: пересказывай их безлично («ушла в тестирование», «вернулась в работу»), не от первого лица;
- по абзацу на каждое направление, по которому за период что-то было (события или пункты из сессий): «Касаемо задачи по <тема коротко, как в разговоре: «по поиску», «по редиректам»> - что было, с кем говорил, что решили, чего жду.»; следующей строкой номера задач направления: «1. WEB-34  2. APP-12»;
- если направление за период только взято в работу — одна фраза «Взял в работу задачу по …»;
- пункты без направления в текст не включай;
- последний абзац «Сегодня: …» — из блока «На сегодня»; блок пуст — абзаца нет;
- разговорный тон, как в образце; без markdown и без списков, кроме строки с номерами задач.

Образец стиля:
Касаемо задачи по поиску - была проблема, что бэк не возвращал данные. пообщался с Иваном Петровым и он сказал что это баг бэка. Сказал добавить перевод в админку и создать задачу на фикс бага. Задачу я сейчас создаю.
1. WEB-34  2. APP-12

Касаемо задачи по редиректам - создал задачу на девопсов через их дашборд. Жду реакции.
1. OPS-4601

Взял в работу задачу по стораджам.`;

export interface SummaryPromptInput {
  periodStart: string;
  periodEnd: string;
  sessions: PreparedSession[];
  directions: Direction[];
  digest: PeriodDigest;
}

function dayMonth(date: string): string {
  const [, month, day] = date.split('-');
  return `${day}.${month}`;
}

function orNone(lines: string[]): string[] {
  return lines.length === 0 ? ['- нет'] : lines;
}

function containsKey(text: string, key: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9])${key}(?![0-9])`, 'i').test(text);
}

export function directionHints(session: PreparedSession, directions: readonly Direction[]): Direction[] {
  const haystack = [...session.branches, ...session.messages.map(m => m.text)].join('\n');
  return directions.filter(d => d.tickets.some(t => containsKey(haystack, t.key)));
}

export function buildSummaryPrompt(input: SummaryPromptInput): string {
  const active = input.directions.filter(d => d.status !== 'done');
  const directionLines = active.map(d => {
    const waiting = d.status === 'waiting' && d.waitingFor ? ` · жду: ${d.waitingFor}` : '';
    const keys = d.tickets.length === 0 ? 'нет' : d.tickets.map(t => t.key).join(', ');
    return `- id=${d.id} · «${d.title}» · ${STATUS_LABELS[d.status]}${waiting} · задачи: ${keys}`;
  });
  const eventLines = input.digest.groups.flatMap(g => g.events.map(e => `- «${g.direction.title}» · ${localStamp(e.at)} · ${e.source === 'jira' ? `[Jira] ${eventSentence(e)}` : e.text}`));
  const todayLines = [
    ...input.digest.today.directions.map(d => `- продолжаю: «${d.title}»`),
    ...input.digest.today.todos.map(t => `- дело: ${todoLabel(t)}${t.due ? ` · срок ${dayMonth(t.due)}` : ''}`),
  ];
  const sessionBlocks = input.sessions.map(s => {
    const hints = directionHints(s, active);
    const head = `=== sessionId=${s.sessionId} · ${localStamp(s.firstAt)}–${localStamp(s.lastAt)} · ветки: ${s.branches.length === 0 ? 'нет' : s.branches.join(', ')} · подсказка: ${hints.length === 0 ? 'нет' : hints.map(d => `«${d.title}»`).join(', ')} ===`;
    const body = s.messages.map(m => `${m.role === 'user' ? '[он]' : '[помощник]'} ${m.text}`);
    return [head, ...body].join('\n');
  });
  return [
    SUMMARY_MARKER,
    `Ты готовишь материалы к ежедневному созвону (дейлику) фронтенд-разработчика. Ниже — его переписка с помощником по программированию за период ${localStamp(input.periodStart)} — ${localStamp(input.periodEnd)}, его рабочие направления и события этого периода (с пометкой [Jira] — изменения из Jira). Верни JSON по схеме.`,
    '',
    INSTRUCTIONS,
    '',
    'Направления:',
    ...orNone(directionLines),
    '',
    'События периода:',
    ...orNone(eventLines),
    '',
    'На сегодня:',
    ...orNone(todayLines),
    '',
    'Сессии:',
    sessionBlocks.join('\n\n'),
  ].join('\n');
}

export interface ClaudeOptions {
  bin: string;
  /** Claude takes sonnet without one, Codex its own default */
  model?: string;
  cwd: string;
  timeoutMs: number;
}

/** the agent that writes the daily text */
export interface SummaryAgent extends ClaudeOptions {
  agent: Agent;
}

const running = new Set<() => void>();

/** Stops every summary run still going, so none outlives the server */
export function stopSummaryRuns(): void {
  for (const stop of running) stop();
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** runs the agent with the prompt on stdin; rejects only when it cannot start, times out or is stopped */
function runProcess(name: Agent, bin: string, args: string[], opts: { cwd: string; timeoutMs: number; input: string }): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stopped = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeoutMs);
    const stop = (): void => {
      stopped = true;
      child.kill('SIGTERM');
    };
    running.add(stop);
    child.stdout.setEncoding('utf8').on('data', chunk => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', chunk => (stderr += chunk));
    // the child may exit before reading its input
    child.stdin.on('error', () => undefined);
    child.on('error', error => {
      clearTimeout(timer);
      running.delete(stop);
      reject(isErrorCode(error, 'ENOENT') ? new Error(`Не найден ${name}: ${bin}`) : error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      running.delete(stop);
      if (stopped) reject(new Error('Сборка остановлена: сервер выключился'));
      else if (timedOut) reject(new Error(`Сборка из сессий не уложилась в ${opts.timeoutMs / MS_PER_SECOND} с`));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.end(opts.input);
  });
}

export async function runClaude(prompt: string, opts: ClaudeOptions): Promise<unknown> {
  const args = [
    '-p',
    '--model',
    opts.model ?? 'sonnet',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(SUMMARY_SCHEMA),
    '--no-session-persistence',
    '--tools',
    '',
    '--setting-sources',
    '',
    '--disable-slash-commands',
    '--strict-mcp-config',
  ];
  const result = await runProcess('claude', opts.bin, args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, input: prompt });
  if (result.code !== 0) throw exitError(result.code, result.stdout, result.stderr);
  return structuredOutput(result.stdout);
}

/** `codex exec` without a saved session; the prompt goes on stdin, since a prompt argument makes it wait for stdin to end anyway */
export async function runCodex(prompt: string, opts: ClaudeOptions): Promise<unknown> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worklog-codex-'));
  try {
    const schema = path.join(dir, 'schema.json');
    const answer = path.join(dir, 'answer.json');
    await writeFile(schema, JSON.stringify(SUMMARY_SCHEMA));
    const model = opts.model === undefined ? [] : ['-m', opts.model];
    // an empty folder and no user config: no AGENTS.md, MCP servers or settings reach the summary
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '-s', 'read-only', '-C', dir, '-o', answer, '--output-schema', schema, ...model, '-'];
    const result = await runProcess('codex', opts.bin, args, { cwd: dir, timeoutMs: opts.timeoutMs, input: prompt });
    if (result.code !== 0) throw new Error(`codex завершился с кодом ${result.code}: ${lastLine(result.stderr) || 'нет вывода'}`);
    const parsed: unknown = await readFile(answer, 'utf8').then(text => JSON.parse(text)).catch(() => null);
    if (!isRecord(parsed)) throw new Error('codex вернул ответ без структуры');
    return parsed;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function runSummaryAgent(prompt: string, opts: SummaryAgent): Promise<unknown> {
  return opts.agent === 'codex' ? runCodex(prompt, opts) : runClaude(prompt, opts);
}

// with --output-format json claude reports its own failures (limits, auth) on stdout
function exitError(code: number | null, stdout: string, stderr: string): Error {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (isRecord(parsed) && parsed.is_error === true && typeof parsed.result === 'string') return new Error(`claude: ${parsed.result}`);
  } catch {
    // not JSON: fall back to stderr
  }
  return new Error(`claude завершился с кодом ${code}: ${lastLine(stderr) || 'нет вывода'}`);
}

function lastLine(text: string): string {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '');
  return (lines.at(-1) ?? '').slice(0, STDERR_TAIL);
}

function noStructure(): Error {
  return new Error('claude вернул ответ без структуры');
}

function structuredOutput(stdout: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw noStructure();
  }
  if (!isRecord(parsed)) throw noStructure();
  if (parsed.is_error === true) throw new Error(`claude: ${typeof parsed.result === 'string' ? parsed.result : 'ошибка'}`);
  if (!isRecord(parsed.structured_output)) throw noStructure();
  return parsed.structured_output;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

export function parseSummary(
  output: unknown,
  sessions: readonly PreparedSession[],
  directionIds: ReadonlySet<string>,
  now: Date,
): { summary: SessionSummary; prose: string | null } {
  if (!isRecord(output) || !Array.isArray(output.sessions) || !Array.isArray(output.todoCandidates) || typeof output.prose !== 'string') {
    throw noStructure();
  }
  const lastAt = new Map(sessions.map(s => [s.sessionId, s.lastAt]));
  const direction = (value: unknown): string | null => {
    const id = nullableString(value);
    return typeof id === 'string' && directionIds.has(id) ? id : null;
  };

  const items: SummaryItem[] = [];
  for (const entry of output.sessions) {
    if (!isRecord(entry) || typeof entry.sessionId !== 'string' || !Array.isArray(entry.items)) continue;
    const at = lastAt.get(entry.sessionId);
    if (at === undefined) continue;
    const texts = entry.items.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(x => x !== '');
    for (const text of texts.slice(0, MAX_ITEMS)) {
      items.push({ id: newId(), sessionId: entry.sessionId, at, directionId: direction(entry.directionId), text });
    }
  }

  const candidates: TodoCandidate[] = [];
  for (const entry of output.todoCandidates) {
    if (!isRecord(entry) || typeof entry.sessionId !== 'string' || typeof entry.text !== 'string') continue;
    const text = entry.text.trim();
    if (text === '' || !lastAt.has(entry.sessionId)) continue;
    const requestedBy = nullableString(entry.requestedBy)?.trim() || null;
    candidates.push({ id: newId(), sessionId: entry.sessionId, text, requestedBy, directionId: direction(entry.directionId) });
  }

  const prose = output.prose.trim();
  return { summary: { ranAt: now.toISOString(), sessionCount: sessions.length, items, candidates }, prose: prose === '' ? null : prose };
}
