import { mkdirSync, watch as fsWatch } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { LOCK_DIR_NAMES, TMP_MARKER } from './fs-utils.ts';

const OK = 200;
const DEBOUNCE_MS = 150;
const MAX_WAIT_MS = 1_000;
const PING_MS = 25_000;
const REWATCH_MS = 1_000;
const CHANGE_FRAME = 'event: change\ndata: {}\n\n';
const PING_FRAME = ': ping\n\n';

export interface Watcher {
  close(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** Calls onChange with the changed file's path relative to dir, null when unknown */
export type WatchFn = (dir: string, onChange: (filename: string | null) => void) => Watcher;

export interface LiveHubOptions {
  dataDir: string;
  idleMs: number;
  onIdle: () => void;
  pingMs?: number;
  watch?: WatchFn;
}

export interface LiveHub {
  handle(req: IncomingMessage, res: ServerResponse): void;
  clientCount(): number;
  /** Any request: with no windows open, the idle countdown starts over */
  touch(): void;
  /** Tells the windows to reload, for what changes outside the data files */
  notify(): void;
  close(): void;
}

const watchRecursive: WatchFn = (dir, onChange) => fsWatch(dir, { recursive: true }, (_event, filename) => onChange(filename));

export function createLiveHub(opts: LiveHubOptions): LiveHub {
  const watch = opts.watch ?? watchRecursive;
  const clients = new Set<ServerResponse>();
  let closed = false;
  let idleTimer: NodeJS.Timeout | undefined;
  let debounceTimer: NodeJS.Timeout | undefined;
  let rewatchTimer: NodeJS.Timeout | undefined;
  let pendingSince: number | undefined;
  let watcher: Watcher | undefined;

  const broadcast = (frame: string): void => {
    for (const res of clients) res.write(frame);
  };
  const flushChange = (): void => {
    debounceTimer = undefined;
    pendingSince = undefined;
    broadcast(CHANGE_FRAME);
  };
  // waits for a quiet spell, but a steady stream of writes still goes out at least once per MAX_WAIT_MS
  const scheduleChange = (): void => {
    const now = Date.now();
    pendingSince ??= now;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushChange, Math.max(0, Math.min(DEBOUNCE_MS, pendingSince + MAX_WAIT_MS - now)));
  };
  const startIdleTimer = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      opts.onIdle();
    }, opts.idleMs);
  };
  const stopIdleTimer = (): void => {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const startWatching = (): void => {
    // fs.watch needs an existing directory; on first launch data/ does not exist yet
    mkdirSync(opts.dataDir, { recursive: true });
    const current = watch(opts.dataDir, filename => {
      if (filename !== null && isIgnored(filename)) return;
      scheduleChange();
    });
    current.on('error', error => {
      console.error('Наблюдение за данными прервано, перезапуск через 1 с:', error);
      current.close();
      if (watcher === current) watcher = undefined;
      rewatchLater();
    });
    watcher = current;
  };
  const rewatchLater = (): void => {
    if (closed) return;
    clearTimeout(rewatchTimer);
    rewatchTimer = setTimeout(() => {
      rewatchTimer = undefined;
      if (closed) return;
      try {
        startWatching();
      } catch (error) {
        console.error('Не удалось возобновить наблюдение за данными:', error);
        rewatchLater();
        return;
      }
      // writes made while nobody watched would otherwise stay unseen
      broadcast(CHANGE_FRAME);
    }, REWATCH_MS);
  };

  startWatching();
  const pingTimer = setInterval(() => broadcast(PING_FRAME), opts.pingMs ?? PING_MS);
  startIdleTimer();

  return {
    handle(_req, res) {
      res.writeHead(OK, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.flushHeaders();
      clients.add(res);
      stopIdleTimer();
      res.on('close', () => {
        clients.delete(res);
        if (!closed && clients.size === 0) startIdleTimer();
      });
    },
    clientCount: () => clients.size,
    touch() {
      if (!closed && clients.size === 0) startIdleTimer();
    },
    notify() {
      if (!closed) scheduleChange();
    },
    close() {
      closed = true;
      watcher?.close();
      watcher = undefined;
      clearTimeout(debounceTimer);
      clearTimeout(rewatchTimer);
      clearInterval(pingTimer);
      stopIdleTimer();
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}

function isIgnored(filename: string): boolean {
  const name = path.basename(filename);
  return LOCK_DIR_NAMES.some(lock => lock === name) || name.includes(TMP_MARKER);
}
