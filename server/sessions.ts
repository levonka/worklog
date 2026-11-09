import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { SUMMARY_LIMITS, compareText } from '../shared/model.ts';
import { isErrorCode, readdirIfExists } from './fs-utils.ts';
import { isRecord } from './guards.ts';

export const SUMMARY_MARKER = '<worklog-summary-request>';

export interface SessionMessage {
  at: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface PreparedSession {
  sessionId: string;
  project: string;
  cwds: string[];
  branches: string[];
  firstAt: string;
  lastAt: string;
  messages: SessionMessage[];
}

export interface SummaryLimits {
  messageChars: number;
  sessionChars: number;
  totalChars: number;
}

const TRANSCRIPT_EXT = '.jsonl';
const SKIPPED_PREFIXES = ['<local-command-caveat>', '<command-name>', '<local-command-stdout>', '<task-notification>', '<system-reminder>'];
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const HEAD_SHARE = 0.4;

export async function collectSessions(opts: { projectsDir: string; start: string; end: string }): Promise<PreparedSession[]> {
  const files = await transcriptFiles(opts.projectsDir, new Date(opts.start).getTime());
  const sessions = await Promise.all(files.map(({ project, file }) => readIfPresent(() => readTranscript(project, file, opts.start, opts.end))));
  return sessions.filter(session => session !== null).sort((a, b) => compareText(a.firstAt, b.firstAt));
}

async function transcriptFiles(projectsDir: string, since: number): Promise<{ project: string; file: string }[]> {
  const projects = await readdirIfExists(projectsDir);
  const perProject = await Promise.all(
    projects.map(async project => {
      let names: string[];
      try {
        names = await readdir(path.join(projectsDir, project));
      } catch {
        return [];
      }
      const files = names.filter(n => n.endsWith(TRANSCRIPT_EXT)).map(name => path.join(projectsDir, project, name));
      const mtimes = await Promise.all(files.map(mtimeOf));
      // a file untouched since the start of the period holds nothing from it
      return files.filter((_, i) => (mtimes[i] ?? -1) >= since).map(file => ({ project, file }));
    }),
  );
  return perProject.flat();
}

// Claude Code removes old transcripts on start: one may vanish between readdir and here
export async function mtimeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs;
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}

// Claude Code and Codex remove old transcripts: one may vanish between readdir and reading
export async function readIfPresent(read: () => Promise<PreparedSession | null>): Promise<PreparedSession | null> {
  try {
    return await read();
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}

/** a session with its period, or null when it is the summary's own run or the person said nothing */
export function finishSession(meta: Omit<PreparedSession, 'firstAt' | 'lastAt' | 'messages'>, messages: SessionMessage[], marked: boolean): PreparedSession | null {
  if (marked || !messages.some(m => m.role === 'user')) return null;
  const times = messages.map(m => m.at).sort();
  return { ...meta, firstAt: times[0], lastAt: times[times.length - 1], messages };
}

async function readTranscript(project: string, file: string, start: string, end: string): Promise<PreparedSession | null> {
  const messages: SessionMessage[] = [];
  const cwds = new Set<string>();
  const branches = new Set<string>();
  let sessionId = path.basename(file, TRANSCRIPT_EXT);
  let marked = false;

  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    const record = parseLine(line);
    if (record === null) continue;
    const at = record.timestamp;
    if (typeof at !== 'string' || at < start || at >= end) continue;
    if (record.isSidechain === true || record.isMeta === true) continue;
    const role = record.type === 'user' ? 'user' : record.type === 'assistant' ? 'assistant' : null;
    if (role === null) continue;
    const text = role === 'user' ? userText(record.message) : assistantText(record.message);
    if (text === null) continue;
    if (role === 'user' && text.includes(SUMMARY_MARKER)) marked = true;
    if (typeof record.sessionId === 'string') sessionId = record.sessionId;
    if (typeof record.cwd === 'string' && record.cwd !== '') cwds.add(record.cwd);
    if (typeof record.gitBranch === 'string' && record.gitBranch !== '' && record.gitBranch !== 'HEAD') branches.add(record.gitBranch);
    messages.push({ at, role, text });
  }

  return finishSession({ sessionId, project, cwds: [...cwds], branches: [...branches] }, messages, marked);
}

export function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    // a line still being written by a live session
    return null;
  }
}

function contentOf(message: unknown): unknown {
  return isRecord(message) ? message.content : undefined;
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
  }
  return texts;
}

function userText(message: unknown): string | null {
  const content = contentOf(message);
  const raw = typeof content === 'string' ? content : textBlocks(content).join('\n');
  if (SKIPPED_PREFIXES.some(prefix => raw.trimStart().startsWith(prefix))) return null;
  const text = raw.replace(REMINDER, '').trim();
  return text === '' ? null : text;
}

function assistantText(message: unknown): string | null {
  const text = textBlocks(contentOf(message)).join('\n').trim();
  return text === '' ? null : text;
}

export function fitToBudget(sessions: PreparedSession[], limits: SummaryLimits = SUMMARY_LIMITS): PreparedSession[] {
  if (sessions.length === 0) return [];
  const budget = Math.min(limits.sessionChars, Math.floor(limits.totalChars / sessions.length));
  return sessions.map(session => {
    const messages = session.messages.map(m => (m.text.length > limits.messageChars ? { ...m, text: `${m.text.slice(0, limits.messageChars)}…` } : m));
    return { ...session, messages: keepHeadAndTail(messages, budget) };
  });
}

// the start says what was asked, the end what came of it; at least one message of each survives
function keepHeadAndTail(messages: SessionMessage[], budget: number): SessionMessage[] {
  const size = (list: SessionMessage[]): number => list.reduce((sum, m) => sum + m.text.length, 0);
  if (size(messages) <= budget || messages.length < 2) return messages;
  const head: SessionMessage[] = [messages[0]];
  let used = messages[0].text.length;
  for (let i = 1; i < messages.length - 1 && used + messages[i].text.length <= budget * HEAD_SHARE; i++) {
    head.push(messages[i]);
    used += messages[i].text.length;
  }
  const tail: SessionMessage[] = [messages[messages.length - 1]];
  used = tail[0].text.length;
  for (let i = messages.length - 2; i >= head.length && used + messages[i].text.length <= budget * (1 - HEAD_SHARE); i--) {
    tail.unshift(messages[i]);
    used += messages[i].text.length;
  }
  const skipped = messages.length - head.length - tail.length;
  if (skipped === 0) return messages;
  const gap: SessionMessage = { at: head[head.length - 1].at, role: 'assistant', text: `[… пропущено ${skipped} сообщений …]` };
  return [...head, gap, ...tail];
}
