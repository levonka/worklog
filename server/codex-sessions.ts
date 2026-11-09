import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { compareText } from '../shared/model.ts';
import { isErrorCode } from './fs-utils.ts';
import { isRecord } from './guards.ts';
import type { PreparedSession, SessionMessage } from './sessions.ts';
import { SUMMARY_MARKER, finishSession, mtimeOf, parseLine, readIfPresent } from './sessions.ts';

const ROLLOUT = /^rollout-.*\.jsonl$/;
// context Codex puts into the user's turn by itself
const INJECTED = ['<environment_context>', '# AGENTS.md instructions', '<turn_aborted>', '<user_instructions>'];
const BLOCK_TYPES = { user: 'input_text', assistant: 'output_text' } as const;

/** Codex sessions of the period as the daily summary takes them: what the person said and what the agent answered */
export async function collectCodexSessions(opts: { sessionsDir: string; start: string; end: string }): Promise<PreparedSession[]> {
  const files = await rolloutFiles(opts.sessionsDir, new Date(opts.start).getTime());
  const sessions = await Promise.all(files.map(file => readIfPresent(() => parseRollout(file, opts.start, opts.end))));
  return sessions.filter(session => session !== null).sort((a, b) => compareText(a.firstAt, b.firstAt));
}

async function rolloutFiles(sessionsDir: string, since: number): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(sessionsDir, { recursive: true });
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return [];
    throw error;
  }
  const files = names.filter(name => ROLLOUT.test(path.basename(name))).map(name => path.join(sessionsDir, name));
  const mtimes = await Promise.all(files.map(mtimeOf));
  return files.filter((_, i) => (mtimes[i] ?? -1) >= since);
}

async function parseRollout(file: string, start: string, end: string): Promise<PreparedSession | null> {
  const messages: SessionMessage[] = [];
  const cwds = new Set<string>();
  const branches = new Set<string>();
  let sessionId = path.basename(file, '.jsonl');
  let marked = false;
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    const record = parseLine(line);
    const payload = record === null ? null : record.payload;
    if (record === null || !isRecord(payload)) continue;
    if (record.type === 'session_meta') {
      if (typeof payload.id === 'string') sessionId = payload.id;
      if (typeof payload.cwd === 'string' && payload.cwd !== '') cwds.add(payload.cwd);
      if (isRecord(payload.git) && typeof payload.git.branch === 'string' && payload.git.branch !== '' && payload.git.branch !== 'HEAD') branches.add(payload.git.branch);
      continue;
    }
    const at = record.timestamp;
    if (record.type !== 'response_item' || payload.type !== 'message' || typeof at !== 'string' || at < start || at >= end) continue;
    const role = payload.role === 'user' ? 'user' : payload.role === 'assistant' ? 'assistant' : null;
    if (role === null) continue;
    const text = messageText(payload.content, BLOCK_TYPES[role]);
    if (text === null) continue;
    if (role === 'user' && text.includes(SUMMARY_MARKER)) marked = true;
    messages.push({ at, role, text });
  }
  const [cwd] = cwds;
  return finishSession({ sessionId, project: cwd === undefined ? 'codex' : cwd.replace(/[/.]/g, '-'), cwds: [...cwds], branches: [...branches] }, messages, marked);
}

function messageText(content: unknown, blockType: string): string | null {
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== blockType || typeof block.text !== 'string') continue;
    const text = block.text.trim();
    if (text !== '' && !INJECTED.some(prefix => text.startsWith(prefix))) texts.push(text);
  }
  return texts.length === 0 ? null : texts.join('\n');
}
