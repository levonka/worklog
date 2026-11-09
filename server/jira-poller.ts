import type { JiraHealth } from '../shared/model.ts';
import { jiraTicketKeys } from '../shared/model.ts';
import type { JiraFetch } from './jira.ts';
import type { Store } from './store.ts';

export interface JiraPollerOptions {
  store: Store;
  /** builds the client from the certificate, token and password, or says what is missing */
  connect: () => Promise<JiraFetch | string>;
  pollMs: number;
  /** the state or its message changed */
  onHealth: () => void;
  now?: () => Date;
}

export interface JiraPoller {
  /** polls now and every pollMs; only once the server owns its port */
  start(): void;
  /** polls at once; a poll already running is shared */
  refresh(): Promise<JiraHealth>;
  health(): JiraHealth;
  close(): void;
}

export function createJiraPoller(opts: JiraPollerOptions): JiraPoller {
  const now = opts.now ?? (() => new Date());
  let current: JiraHealth = { state: 'ok', message: null, checkedAt: null, polling: false };
  // kept while it works; built again after a failure, so a replaced token or a finished setup is picked up
  let client: JiraFetch | null = null;
  let running: Promise<JiraHealth> | null = null;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const settle = (next: Omit<JiraHealth, 'polling'>): JiraHealth => {
    const changed = next.state !== current.state || next.message !== current.message;
    current = { ...next, polling: false };
    if (changed && !closed) opts.onHealth();
    return current;
  };

  const poll = async (): Promise<JiraHealth> => {
    current = { ...current, polling: true };
    try {
      if (client === null) {
        const connected = await opts.connect();
        if (typeof connected === 'string') return settle({ state: 'off', message: connected, checkedAt: current.checkedAt });
        client = connected;
      }
      const keys = jiraTicketKeys((await opts.store.read()).directions);
      const issues = keys.length === 0 ? [] : await client(keys);
      const at = now().toISOString();
      if (!closed && issues.length > 0) await opts.store.applyJira(issues, at);
      return settle({ state: 'ok', message: null, checkedAt: at });
    } catch (error) {
      client = null;
      return settle({ state: 'error', message: error instanceof Error ? error.message : String(error), checkedAt: current.checkedAt });
    }
  };

  const refresh = (): Promise<JiraHealth> => {
    running ??= poll().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    start() {
      if (closed || timer !== undefined) return;
      void refresh();
      timer = setInterval(() => void refresh(), opts.pollMs);
      timer.unref();
    },
    refresh,
    health: () => current,
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}
