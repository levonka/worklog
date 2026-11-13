import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentConfig } from './agent-launch.ts';
import type { Terminal } from '../shared/model.ts';
import { branchPlace, launchAgent, promptFile, tabConfig, tabFile, terminalCommand } from './agent-launch.ts';
import { Store } from './store.ts';
import { TEST_PROFILE } from '../shared/test-profile.ts';

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** an `open` that records its arguments, or fails */
async function fakeOpen(dir: string, fails = false): Promise<{ bin: string; calls: string }> {
  const bin = path.join(dir, 'open');
  const calls = path.join(dir, 'calls.txt');
  await writeFile(bin, fails ? '#!/bin/sh\necho "нет Warp" >&2\nexit 1\n' : `#!/bin/sh\nprintf '%s\\n' "$@" >> '${calls}'\n`);
  await chmod(bin, 0o755);
  return { bin, calls };
}

/** an `osascript` that records its arguments one per line, or fails */
async function fakeOsascript(dir: string, fails = false, stderr = 'нет доступа'): Promise<{ bin: string; calls: string }> {
  const bin = path.join(dir, 'osascript');
  const calls = path.join(dir, 'osascript.txt');
  await writeFile(bin, fails ? `#!/bin/sh\necho '${stderr}' >&2\nexit 1\n` : `#!/bin/sh\nprintf '%s\\n' "$@" >> '${calls}'\n`);
  await chmod(bin, 0o755);
  return { bin, calls };
}

async function setup(t: TestContext, opts: { fails?: boolean; terminal?: Terminal; stderr?: string } = {}) {
  const dataDir = await tempDir(t, 'worklog-agent-data-');
  const tools = await tempDir(t, 'worklog-agent-tools-');
  const open = await fakeOpen(tools, opts.fails);
  const osascript = await fakeOsascript(tools, opts.fails, opts.stderr);
  const config: AgentConfig = {
    runsDir: path.join(dataDir, 'runs'),
    codeRoot: '/Users/me/Projects/app',
    bins: { claude: '/usr/local/bin/claude' },
    defaultAgent: 'claude',
    terminal: opts.terminal ?? 'warp',
    warpTabDir: path.join(tools, 'tab_configs'),
    openBin: open.bin,
    osascriptBin: osascript.bin,
  };
  const store = new Store(dataDir, { profile: TEST_PROFILE });
  const direction = await store.createDirection({ title: 'Сторы "App"', ticketKeys: ['APP-6120'] });
  return { store, config, direction, calls: open.calls, osascriptCalls: osascript.calls };
}

test('launchAgent records the run, writes the prompt and the tab config, and opens it in Warp', async t => {
  const { store, config, direction, calls } = await setup(t);
  const run = await launchAgent(store, config, { template: 'execute', directionId: direction.id, include: ['tickets'], extra: '', branch: 'feature/APP-6120' });

  assert.equal(run.directionId, direction.id);
  assert.equal(run.branch, 'feature/APP-6120');
  assert.equal(run.title, 'Сторы "App" · выполнить задачу');
  assert.deepEqual((await store.read()).runs, [run]);
  assert.match(await readFile(promptFile(config, run.id), 'utf8'), /APP-6120 \(App\)/);
  assert.equal(await readFile(tabFile(config, run.id), 'utf8'), tabConfig(config, run));
  assert.equal(await readFile(calls, 'utf8'), `warp://tab_config/worklog-run-${run.id}\n`);
});

test('tabConfig runs claude in the code root with the prompt file, after removing itself', async t => {
  const { config } = await setup(t);
  const text = tabConfig({ ...config, bins: { claude: "/opt/it's/claude" } }, { id: 'abc', template: 'execute', branch: 'dev', title: 'Сео "x"', startedAt: '' });
  assert.match(text, /^name = "✦ Сео \\"x\\""\ntitle = "✦ Сео \\"x\\""\n/);
  assert.match(text, /\[\[panes\]\]\nid = "main"\ntype = "terminal"\ndirectory = "\/Users\/me\/Projects\/app"\n/);
  const command = JSON.parse(/^commands = \[(.*)\]$/m.exec(text)?.[1] ?? '""');
  assert.equal(
    command,
    `rm -f '${config.warpTabDir}/worklog-run-abc.toml'; WORKLOG_RUN_ID=abc '/opt/it'\\''s/claude' "$(cat '${config.runsDir}/abc.md')"`,
  );
});

test('the tab command hands the prompt over unchanged', async t => {
  const { config } = await setup(t);
  const dir = path.dirname(config.openBin);
  const fakeClaude = path.join(dir, 'claude');
  const received = path.join(dir, 'received.txt');
  await writeFile(fakeClaude, `#!/bin/sh\nprintf '%s|%s' "$WORKLOG_RUN_ID" "$1" > '${received}'\n`);
  await chmod(fakeClaude, 0o755);
  const local = { ...config, bins: { claude: fakeClaude } };
  const prompt = 'строка "в кавычках" $HOME `date` \'одинарные\'\nвторая';
  await mkdir(local.runsDir, { recursive: true });
  await writeFile(promptFile(local, 'r1'), prompt);
  const text = tabConfig(local, { id: 'r1', template: 'execute', branch: 'dev', title: 'x', startedAt: '' });
  const command = JSON.parse(/^commands = \[(.*)\]$/m.exec(text)?.[1] ?? '""');
  execFileSync('/bin/zsh', ['-c', command]);
  assert.equal(await readFile(received, 'utf8'), `r1|${prompt}`);
});

for (const terminal of ['terminal', 'iterm'] as const) {
  test(`${terminal} gets the command as an argument, not inside the script`, async t => {
    const { store, config, direction, osascriptCalls } = await setup(t, { terminal });
    const run = await launchAgent(store, config, { template: 'question', directionId: direction.id, include: [], extra: 'Вопрос', branch: 'dev' });

    const args = (await readFile(osascriptCalls, 'utf8')).trimEnd().split('\n');
    assert.equal(args.at(-1), terminalCommand(config, run));
    const script = args.slice(0, -1);
    assert.ok(script.length > 0 && script.every((arg, i) => (i % 2 === 0 ? arg === '-e' : !arg.includes(config.runsDir))), script.join('\n'));
    assert.match(script.join('\n'), terminal === 'iterm' ? /application "iTerm"/ : /application "Terminal"/);
    assert.equal(await readFile(promptFile(config, run.id), 'utf8').then(text => text.length > 0), true);
  });
}

test('terminal command keeps a code root with a quote and a space as one word', async t => {
  const { config } = await setup(t, { terminal: 'terminal' });
  assert.equal(
    terminalCommand({ ...config, codeRoot: "/tmp/it's dir" }, { id: 'r1', template: 'execute', branch: 'dev', title: 'x', startedAt: '' }),
    `cd '/tmp/it'\\''s dir' && WORKLOG_RUN_ID=r1 '/usr/local/bin/claude' "$(cat '${config.runsDir}/r1.md')"`,
  );
});

test('a failed osascript leaves no run and says which terminal', async t => {
  const { store, config, direction } = await setup(t, { fails: true, terminal: 'terminal' });
  await assert.rejects(
    launchAgent(store, config, { template: 'execute', directionId: direction.id, include: [], extra: '', branch: 'dev' }),
    /Не удалось открыть: новое окно Терминала \(.*нет доступа.*\)/s,
  );
  assert.deepEqual((await store.read()).runs, []);
  assert.deepEqual(await readdir(config.runsDir).catch(() => []), []);
});

test('a failed osascript shows its own words, not the command', async t => {
  const { store, config, direction } = await setup(t, { fails: true, terminal: 'terminal', stderr: '0:42: execution error: что-то сломалось (-1)' });
  await assert.rejects(launchAgent(store, config, { template: 'execute', directionId: direction.id, include: [], extra: '', branch: 'dev' }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Не удалось открыть: новое окно Терминала (0:42: execution error: что-то сломалось (-1))');
    return true;
  });
});

test('a refused Automation permission says where to allow it', async t => {
  const { store, config, direction } = await setup(t, { fails: true, terminal: 'terminal', stderr: '0:57: execution error: Not authorized to send Apple events to Terminal. (-1743)' });
  await assert.rejects(
    launchAgent(store, config, { template: 'execute', directionId: direction.id, include: [], extra: '', branch: 'dev' }),
    { message: 'Не удалось открыть: новое окно Терминала (нет разрешения управлять им: Системные настройки → Конфиденциальность и безопасность → Автоматизация)' },
  );
});

test('a failed open leaves no run, prompt or tab config', async t => {
  const { store, config, direction } = await setup(t, { fails: true });
  await assert.rejects(
    launchAgent(store, config, { template: 'execute', directionId: direction.id, include: [], extra: '', branch: 'dev' }),
    /Не удалось открыть: новая вкладка Warp \(.*нет Warp.*\)/s,
  );
  assert.deepEqual((await store.read()).runs, []);
  assert.deepEqual(await readdir(config.runsDir).catch(() => []), []);
  assert.deepEqual(await readdir(config.warpTabDir).catch(() => []), []);
});

test('a launch removes tab configs Warp never opened, and only those of Worklog', async t => {
  const { store, config, direction } = await setup(t);
  await mkdir(config.warpTabDir, { recursive: true });
  const old = path.join(config.warpTabDir, 'worklog-run-old1.toml');
  const fresh = path.join(config.warpTabDir, 'worklog-run-new1.toml');
  const own = path.join(config.warpTabDir, 'startup_config.toml');
  for (const file of [old, fresh, own]) await writeFile(file, '');
  const hourAgo = new Date(Date.now() - 3_600_000);
  await utimes(old, hourAgo, hourAgo);
  await utimes(own, hourAgo, hourAgo);

  const run = await launchAgent(store, config, { template: 'execute', directionId: direction.id, include: [], extra: '', branch: 'dev' });
  assert.deepEqual((await readdir(config.warpTabDir)).sort(), ['startup_config.toml', `worklog-run-${run.id}.toml`, 'worklog-run-new1.toml'].sort());
});

test('startRun refuses a bad branch, an empty question and a missing target; finishRun marks once', async t => {
  const { store, direction } = await setup(t);
  const base = { template: 'execute' as const, directionId: direction.id, include: [], extra: '', branch: 'dev' };
  await assert.rejects(store.startRun({ ...base, branch: 'a b' }), /Некорректное имя ветки/);
  await assert.rejects(store.startRun({ ...base, template: 'question', extra: '  ' }), /Для «Вопрос» нужен дополнительный контекст/);
  await assert.rejects(store.startRun({ ...base, directionId: undefined }), /о направлении или деле/);
  await assert.rejects(store.startRun({ ...base, directionId: 'nope' }), /Направление не найдено/);
  await assert.rejects(store.startRun({ ...base, todoId: 'nope' }), /Дело не найдено/);

  const todo = await store.addTodo({ text: 'Обёртки', directionId: direction.id });
  const { run } = await store.startRun({ ...base, directionId: undefined, todoId: todo.id, branch: ' dev ' });
  assert.deepEqual([run.todoId, run.directionId, run.branch], [todo.id, direction.id, 'dev']);

  const finished = await store.finishRun(run.id, new Date('2026-11-05T12:00:00Z'));
  assert.equal(finished.finishedAt, '2026-11-05T12:00:00.000Z');
  assert.equal((await store.finishRun(run.id)).finishedAt, '2026-11-05T12:00:00.000Z');
  await assert.rejects(store.finishRun('nope'), /Запуск агента не найден/);
});

test('branchPlace finds a local branch, a branch only in origin, or none', async t => {
  const repo = await tempDir(t, 'worklog-agent-git-');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'dev');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  git('branch', 'feature/APP-1');
  git('update-ref', 'refs/remotes/origin/feature/APP-2', 'HEAD');

  assert.equal(await branchPlace(repo, 'feature/APP-1'), 'local');
  assert.equal(await branchPlace(repo, 'feature/APP-2'), 'remote');
  assert.equal(await branchPlace(repo, 'feature/APP-3'), 'none');
  await assert.rejects(branchPlace(repo, '$(rm)'), /Некорректное имя ветки/);
});

test('terminal command starts codex in the project folder with the prompt', async t => {
  const { config } = await setup(t, { terminal: 'terminal' });
  const both = { ...config, bins: { claude: '/usr/local/bin/claude', codex: '/opt/bin/codex' } };
  assert.equal(
    terminalCommand(both, { id: 'r1', agent: 'codex', template: 'execute', branch: 'dev', title: 'x', startedAt: '' }),
    `cd '${config.codeRoot}' && WORKLOG_RUN_ID=r1 '/opt/bin/codex' -C '${config.codeRoot}' "$(cat '${config.runsDir}/r1.md')"`,
  );
});

test('Warp tab config runs codex', async t => {
  const { config } = await setup(t);
  const text = tabConfig({ ...config, bins: { codex: '/opt/bin/codex' } }, { id: 'abc', agent: 'codex', template: 'execute', branch: 'dev', title: 'x', startedAt: '' });
  const command = JSON.parse(/^commands = \[(.*)\]$/m.exec(text)?.[1] ?? '""');
  assert.match(command, /WORKLOG_RUN_ID=abc '\/opt\/bin\/codex' -C '/);
});

test('launchAgent records the agent and refuses one that is not installed', async t => {
  const { store, config, direction } = await setup(t, { terminal: 'terminal' });
  const both = { ...config, bins: { claude: '/usr/local/bin/claude', codex: '/opt/bin/codex' }, defaultAgent: 'codex' as const };
  const run = await launchAgent(store, both, { template: 'question', directionId: direction.id, include: [], extra: 'Вопрос', branch: 'dev' });
  assert.equal(run.agent, 'codex');
  await assert.rejects(launchAgent(store, config, { agent: 'codex', template: 'question', directionId: direction.id, include: [], extra: 'Вопрос', branch: 'dev' }), /Агент не установлен: codex/);
});
