import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installedAgents, resolveAgents } from './agents.ts';

test('resolveAgents keeps the old default without settings', () => {
  assert.deepEqual(resolveAgents({}), { main: 'claude', bins: { claude: 'claude' } });
});

test('resolveAgents takes the only installed agent as main', () => {
  const setup = resolveAgents({ codexBin: '/opt/bin/codex' });
  assert.deepEqual(setup, { main: 'codex', bins: { codex: '/opt/bin/codex' } });
  assert.deepEqual(installedAgents(setup.bins), ['codex']);
});

test('resolveAgents prefers claude when both are installed and none is chosen', () => {
  const setup = resolveAgents({ claudeBin: '/opt/bin/claude', codexBin: '/opt/bin/codex' });
  assert.equal(setup.main, 'claude');
  assert.deepEqual(installedAgents(setup.bins), ['claude', 'codex']);
});

test('resolveAgents honours WORKLOG_AGENT and refuses an unknown one', () => {
  assert.equal(resolveAgents({ agent: 'codex', claudeBin: '/opt/bin/claude', codexBin: '/opt/bin/codex' }).main, 'codex');
  assert.equal(resolveAgents({ agent: 'codex', claudeBin: '/opt/bin/claude' }).main, 'codex');
  assert.throws(() => resolveAgents({ agent: 'gpt' }), /WORKLOG_AGENT: gpt \(claude, codex\)/);
});
