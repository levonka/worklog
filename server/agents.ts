import type { Agent } from '../shared/model.ts';
import { AGENTS } from '../shared/model.ts';

/** the main agent writes the daily text and is the default for handed tasks; an agent is installed when its path is set */
export interface AgentSetup {
  main: Agent;
  bins: Partial<Record<Agent, string>>;
}

export function resolveAgents(values: { agent?: string; claudeBin?: string; codexBin?: string }): AgentSetup {
  const bins: Partial<Record<Agent, string>> = {};
  if (values.claudeBin) bins.claude = values.claudeBin;
  if (values.codexBin) bins.codex = values.codexBin;
  if (values.agent) {
    const chosen = AGENTS.find(agent => agent === values.agent);
    if (chosen === undefined) throw new Error(`Некорректное значение WORKLOG_AGENT: ${values.agent} (${AGENTS.join(', ')})`);
    // a chosen agent without a path is not installed: doctor asks for the path, a handed task gets a clear refusal
    return { main: chosen, bins };
  }
  // a machine without settings keeps the behaviour from before Codex
  if (bins.claude === undefined && bins.codex === undefined) bins.claude = 'claude';
  return { main: bins.claude !== undefined ? 'claude' : 'codex', bins };
}

export function installedAgents(bins: AgentSetup['bins']): Agent[] {
  return AGENTS.filter(agent => bins[agent] !== undefined);
}
