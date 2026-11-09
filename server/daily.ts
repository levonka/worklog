import { compareText, localDate, periodDigest } from '../shared/model.ts';
import { collectCodexSessions } from './codex-sessions.ts';
import type { PreparedSession } from './sessions.ts';
import { collectSessions, fitToBudget } from './sessions.ts';
import type { SummaryAgent } from './summarizer.ts';
import { buildSummaryPrompt, parseSummary, runSummaryAgent } from './summarizer.ts';
import type { Store } from './store.ts';

/** where the sessions of each installed agent lie, and the agent that writes the text */
export interface SummaryConfig {
  claudeProjectsDir?: string;
  codexSessionsDir?: string;
  agent: SummaryAgent;
}

/** Marks the run as started and finishes it in the background; `done` settles when the result is saved */
export async function startSummary(store: Store, config: SummaryConfig, now: () => Date = () => new Date()): Promise<{ done: Promise<void> }> {
  const { periodStart } = await store.beginSummaryRun(now());
  return { done: summarize(store, config, periodStart, now) };
}

async function summarize(store: Store, config: SummaryConfig, periodStart: string, now: () => Date): Promise<void> {
  try {
    const end = now();
    const [state, collected] = await Promise.all([store.read(), allSessions(config, periodStart, end.toISOString())]);
    const sessions = fitToBudget(collected);
    if (sessions.length === 0) {
      const summary = { ranAt: end.toISOString(), sessionCount: 0, items: [], candidates: [] };
      await store.finishSummaryRun(periodStart, { summary, prose: null }, now());
      return;
    }
    const digest = periodDigest(state, periodStart, null, localDate(end));
    const prompt = buildSummaryPrompt({ periodStart, periodEnd: end.toISOString(), sessions, directions: state.directions, digest });
    const output = await runSummaryAgent(prompt, config.agent);
    const directionIds = new Set(state.directions.map(d => d.id));
    await store.finishSummaryRun(periodStart, parseSummary(output, sessions, directionIds, now()), now());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.finishSummaryRun(periodStart, { error: message }, now()).catch(() => undefined);
  }
}

async function allSessions(config: SummaryConfig, start: string, end: string): Promise<PreparedSession[]> {
  const [claude, codex] = await Promise.all([
    config.claudeProjectsDir === undefined ? [] : collectSessions({ projectsDir: config.claudeProjectsDir, start, end }),
    config.codexSessionsDir === undefined ? [] : collectCodexSessions({ sessionsDir: config.codexSessionsDir, start, end }),
  ]);
  return [...claude, ...codex].sort((a, b) => compareText(a.firstAt, b.firstAt));
}
