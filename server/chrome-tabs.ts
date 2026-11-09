import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { WorklogState } from '../shared/model.ts';
import { ticketKeysIn } from '../shared/model.ts';
import { chromeProfileDir } from './favicons.ts';

export interface ChromeTab {
  window: number;
  index: number;
  title: string;
  url: string;
}

export interface MatchedTab extends ChromeTab {
  keys: string[];
  /** directions with a ticket from `keys` or with this URL as a link */
  directions: { id: string; title: string }[];
  /** the URL is already a link of a direction, a ticket or a sidebar link */
  saved: boolean;
}

interface Navigation {
  url: string;
  title: string;
}

interface TabRecord {
  navigations: Map<number, Navigation>;
  selected?: number;
  window?: number;
  index?: number;
  closed: boolean;
}

const SNSS_MAGIC = 'SNSS';
const HEADER_BYTES = 8;
const PICKLE_HEADER_BYTES = 4;
const UNKNOWN_INDEX = Number.MAX_SAFE_INTEGER;
const SESSION_FILE = /^Session_\d+$/;
const WEB_URL = /^https?:\/\//i;

// command ids from Chrome's components/sessions/core/session_service_commands.cc
const SET_TAB_WINDOW = 0;
const SET_TAB_INDEX_IN_WINDOW = 2;
const UPDATE_TAB_NAVIGATION = 6;
const SET_SELECTED_NAVIGATION_INDEX = 7;
const TAB_CLOSED = 16;
const WINDOW_CLOSED = 17;
const TAB_NAVIGATION_PATH_PRUNED = 24;

/** open http(s) tabs of a Chrome session file, by window and position */
export function parseSnss(data: Buffer): ChromeTab[] {
  if (data.subarray(0, SNSS_MAGIC.length).toString('latin1') !== SNSS_MAGIC) throw new Error('Файл сессии Chrome не в формате SNSS');
  const tabs = new Map<number, TabRecord>();
  const closedWindows = new Set<number>();
  const tab = (id: number): TabRecord => {
    let found = tabs.get(id);
    if (!found) tabs.set(id, (found = { navigations: new Map(), closed: false }));
    return found;
  };

  let pos = HEADER_BYTES;
  while (pos + 2 <= data.length) {
    const size = data.readUInt16LE(pos);
    pos += 2;
    // Chrome may be in the middle of writing the last record
    if (size === 0 || pos + size > data.length) break;
    const command = data[pos];
    const payload = data.subarray(pos + 1, pos + size);
    pos += size;
    try {
      applyCommand(command, payload, tab, closedWindows);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }

  const result: ChromeTab[] = [];
  for (const record of tabs.values()) {
    if (record.closed || (record.window !== undefined && closedWindows.has(record.window)) || record.navigations.size === 0) continue;
    const selected = record.selected !== undefined && record.navigations.has(record.selected) ? record.selected : Math.max(...record.navigations.keys());
    const navigation = record.navigations.get(selected);
    if (!navigation || !WEB_URL.test(navigation.url)) continue;
    result.push({ window: record.window ?? 0, index: record.index ?? UNKNOWN_INDEX, title: navigation.title, url: navigation.url });
  }
  return result.sort((a, b) => a.window - b.window || a.index - b.index);
}

function applyCommand(command: number, payload: Buffer, tab: (id: number) => TabRecord, closedWindows: Set<number>): void {
  switch (command) {
    case UPDATE_TAB_NAVIGATION: {
      let offset = PICKLE_HEADER_BYTES;
      const id = payload.readInt32LE(offset);
      const index = payload.readInt32LE(offset + 4);
      offset += 8;
      const url = readString(payload, offset, 1, 'utf8');
      const title = readString(payload, url.next, 2, 'utf16le');
      tab(id).navigations.set(index, { url: url.text, title: title.text });
      break;
    }
    case SET_SELECTED_NAVIGATION_INDEX:
      tab(payload.readInt32LE(0)).selected = payload.readInt32LE(4);
      break;
    case SET_TAB_WINDOW:
      tab(payload.readInt32LE(4)).window = payload.readInt32LE(0);
      break;
    case SET_TAB_INDEX_IN_WINDOW:
      tab(payload.readInt32LE(0)).index = payload.readInt32LE(4);
      break;
    case TAB_CLOSED:
      tab(payload.readInt32LE(0)).closed = true;
      break;
    case WINDOW_CLOSED:
      closedWindows.add(payload.readInt32LE(0));
      break;
    case TAB_NAVIGATION_PATH_PRUNED: {
      const record = tab(payload.readInt32LE(0));
      const from = payload.readInt32LE(4);
      const count = payload.readInt32LE(8);
      const kept = new Map<number, Navigation>();
      for (const [index, navigation] of record.navigations) {
        if (index < from) kept.set(index, navigation);
        else if (index >= from + count) kept.set(index - count, navigation);
      }
      record.navigations = kept;
      break;
    }
  }
}

/** a pickled string: int32 length in units, the bytes, padding to 4 */
function readString(payload: Buffer, offset: number, unitBytes: number, encoding: 'utf8' | 'utf16le'): { text: string; next: number } {
  const bytes = payload.readInt32LE(offset) * unitBytes;
  const start = offset + 4;
  if (bytes < 0 || start + bytes > payload.length) throw new RangeError('Строка выходит за пределы записи');
  return { text: payload.toString(encoding, start, start + bytes), next: start + Math.ceil(bytes / 4) * 4 };
}

/** tabs of the newest session file of the last used Chrome profile; the file is only read */
export async function readChromeTabs(chromeDir: string): Promise<ChromeTab[]> {
  const sessionsDir = path.join(await chromeProfileDir(chromeDir), 'Sessions');
  const file = await newestSessionFile(sessionsDir);
  if (file === null) throw new Error(`Не нашёл файл сессии Chrome в ${sessionsDir}`);
  return parseSnss(await readFile(file));
}

async function newestSessionFile(dir: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  let newest: { file: string; mtime: number } | null = null;
  for (const name of names.filter(n => SESSION_FILE.test(n))) {
    const file = path.join(dir, name);
    const { mtimeMs } = await stat(file);
    if (newest === null || mtimeMs > newest.mtime) newest = { file, mtime: mtimeMs };
  }
  return newest?.file ?? null;
}

function withoutHash(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

export function matchTabs(tabs: readonly ChromeTab[], state: WorklogState): MatchedTab[] {
  const saved = new Set(
    [
      ...state.directions.flatMap(d => [...d.links.map(l => l.url), ...d.tickets.map(t => t.url)]),
      ...state.linkGroups.flatMap(g => g.links.map(l => l.url)),
    ].map(withoutHash),
  );
  return tabs.map(tab => {
    const keys = ticketKeysIn(`${tab.title} ${tab.url}`);
    const url = withoutHash(tab.url);
    const directions = state.directions
      .filter(d => d.tickets.some(t => keys.includes(t.key)) || d.links.some(l => withoutHash(l.url) === url))
      .map(d => ({ id: d.id, title: d.title }));
    return { ...tab, keys, directions, saved: saved.has(url) };
  });
}
