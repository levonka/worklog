import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isErrorCode } from './fs-utils.ts';
import { HttpError, sendJson } from './http.ts';

const DB_NAME = 'Favicons';
const JOURNAL_SUFFIX = '-journal';
const DEFAULT_PROFILE = 'Default';
const LOCAL_STATE = 'Local State';
const PREFERRED_WIDTH = 32;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BROWSER_CACHE_SECONDS = 3600;
// what Chrome sends for the page's own requests and for an address typed by hand
const ALLOWED_FETCH_SITES = ['same-origin', 'none'];
const STATUS_BAD_REQUEST = 400;
const STATUS_FORBIDDEN = 403;
const STATUS_NOT_FOUND = 404;

export interface FaviconsOptions {
  /** Chrome profile folder holding the Favicons database; null turns favicons off */
  profileDir: string | null;
  /** how long a copy of Chrome's database is used before it is copied again */
  snapshotMs: number;
}

export interface Favicons {
  /** the PNG Chrome shows for this link, or null */
  find(url: string): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

interface Snapshot {
  db: DatabaseSync;
  dir: string;
  takenAt: number;
}

export function createFavicons(opts: FaviconsOptions): Favicons {
  let snapshot: Snapshot | null = null;
  let taking: Promise<DatabaseSync | null> | null = null;

  const drop = async (old: Snapshot | null): Promise<void> => {
    if (old === null) return;
    old.db.close();
    await rm(old.dir, { recursive: true, force: true });
  };

  // Chrome keeps its database locked while it runs, so Worklog reads a copy
  const take = async (profileDir: string): Promise<DatabaseSync | null> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'worklog-favicons-'));
    const copy = path.join(dir, DB_NAME);
    let db: DatabaseSync | null = null;
    try {
      await copyFile(path.join(profileDir, DB_NAME), copy);
      await copyFile(path.join(profileDir, DB_NAME + JOURNAL_SUFFIX), copy + JOURNAL_SUFFIX).catch(error => {
        if (!isErrorCode(error, 'ENOENT')) throw error;
      });
      // opened writable: a journal copied mid-write has to be rolled back
      db = new DatabaseSync(copy);
      db.prepare('SELECT icon_id FROM icon_mapping LIMIT 1').get();
    } catch {
      db?.close();
      await rm(dir, { recursive: true, force: true });
      // a copy caught mid-write: the previous one is still good
      return snapshot?.db ?? null;
    }
    const old = snapshot;
    snapshot = { db, dir, takenAt: Date.now() };
    await drop(old);
    return db;
  };

  const database = (): Promise<DatabaseSync | null> => {
    const { profileDir } = opts;
    if (profileDir === null) return Promise.resolve(null);
    if (snapshot !== null && Date.now() - snapshot.takenAt < opts.snapshotMs) return Promise.resolve(snapshot.db);
    taking ??= take(profileDir).finally(() => {
      taking = null;
    });
    return taking;
  };

  return {
    async find(url) {
      const page = parseWebUrl(url);
      if (page === null) return null;
      const db = await database();
      if (db === null) return null;
      try {
        return lookup(db, page);
      } catch {
        return null;
      }
    },
    async close() {
      await taking;
      const old = snapshot;
      snapshot = null;
      await drop(old);
    },
  };
}

function parseWebUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

// the page's own icon first, then the icons of the site's other pages, most used first
function lookup(db: DatabaseSync, page: URL): Uint8Array | null {
  // '0' follows '/' in code order: the range holds exactly the URLs starting with `${origin}/`
  const rows = db.prepare('SELECT page_url, icon_id FROM icon_mapping WHERE page_url >= ? AND page_url < ?').all(`${page.origin}/`, `${page.origin}0`);
  const uses = new Map<number, number>();
  const own = new Set<number>();
  for (const row of rows) {
    const iconId = row.icon_id;
    if (typeof iconId !== 'number') continue;
    uses.set(iconId, (uses.get(iconId) ?? 0) + 1);
    if (row.page_url === page.href) own.add(iconId);
  }
  const ranked = [...uses.keys()].sort((a, b) => Number(own.has(b)) - Number(own.has(a)) || (uses.get(b) ?? 0) - (uses.get(a) ?? 0));
  const bitmaps = db.prepare('SELECT image_data, width FROM favicon_bitmaps WHERE icon_id = ?');
  for (const iconId of ranked) {
    const found = bestBitmap(bitmaps.all(iconId));
    if (found !== null) return found;
  }
  return null;
}

// the smallest of at least 32px, sharp on a Retina screen at 16pt; else the largest
function bestBitmap(rows: readonly Record<string, unknown>[]): Uint8Array | null {
  let best: { data: Uint8Array; width: number } | null = null;
  for (const { image_data: data, width } of rows) {
    if (!(data instanceof Uint8Array) || typeof width !== 'number' || !isPng(data)) continue;
    if (best === null || isBetterWidth(width, best.width)) best = { data, width };
  }
  return best?.data ?? null;
}

function isBetterWidth(width: number, than: number): boolean {
  if (width >= PREFERRED_WIDTH && than >= PREFERRED_WIDTH) return width < than;
  return width > than;
}

function isPng(data: Uint8Array): boolean {
  return data.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, i) => data[i] === byte);
}

/** The Chrome profile last used, as named in Chrome's Local State, else Default */
export async function chromeProfileDir(chromeDir: string): Promise<string> {
  try {
    const state: unknown = JSON.parse(await readFile(path.join(chromeDir, LOCAL_STATE), 'utf8'));
    const name = lastUsedProfile(state);
    if (name !== null && name === path.basename(name) && name !== '..' && name !== '.') return path.join(chromeDir, name);
  } catch {
    // no Chrome or an unreadable Local State
  }
  return path.join(chromeDir, DEFAULT_PROFILE);
}

function lastUsedProfile(state: unknown): string | null {
  if (typeof state !== 'object' || state === null || !('profile' in state)) return null;
  const { profile } = state;
  if (typeof profile !== 'object' || profile === null || !('last_used' in profile)) return null;
  return typeof profile.last_used === 'string' && profile.last_used !== '' ? profile.last_used : null;
}

// Chrome's icons show which sites were visited: no other site may read them, not even through <img>
export async function serveFavicon(req: IncomingMessage, res: ServerResponse, query: URLSearchParams, favicons: Favicons): Promise<void> {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && !ALLOWED_FETCH_SITES.includes(String(site))) throw new HttpError(STATUS_FORBIDDEN, 'Фавиконы доступны только самому Worklog');
  const url = query.get('url');
  if (url === null) throw new HttpError(STATUS_BAD_REQUEST, 'Параметр url обязателен');
  const icon = await favicons.find(url);
  if (icon === null) {
    sendJson(res, STATUS_NOT_FOUND, { error: 'Chrome не знает фавикона этого сайта' });
    return;
  }
  res
    .writeHead(200, {
      'content-type': 'image/png',
      'cache-control': `max-age=${BROWSER_CACHE_SECONDS}`,
      'cross-origin-resource-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
    })
    .end(icon);
}
