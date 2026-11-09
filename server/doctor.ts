import { execFile } from 'node:child_process';
import { access, constants, lstat, readdir, readFile, readlink, stat } from 'node:fs/promises';
import http from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import type { Agent, Profile, ProfileJira, Terminal } from '../shared/model.ts';
import type { Editor } from './code-files.ts';
import { EDITOR_BINS } from './code-files.ts';
import type { AgentSetup } from './agents.ts';
import { installedAgents } from './agents.ts';
import { dataRepoState } from './data-git.ts';
import type { SettingName } from './env-file.ts';
import { isSettingName, parseEnvFile } from './env-file.ts';
import { errorMessage, isErrorCode } from './fs-utils.ts';
import { isRecord } from './guards.ts';
import type { JiraErrorKind, JiraFiles, JiraRequest, ReadPassword } from './jira.ts';
import { JiraError, httpsRequest, jiraConfig, jiraUser, keychainPassword } from './jira.ts';
import { loadProfile } from './profile.ts';
import { Store } from './store.ts';

export const CHECK_IDS = ['macos', 'node', 'git', 'chrome', 'agents', 'env', 'code-root', 'profile', 'web', 'p12', 'token', 'jira', 'port', 'skills', 'codex-data', 'cli', 'terminal', 'editor', 'data'] as const;
export type CheckId = (typeof CHECK_IDS)[number];
export const CHECK_STATUSES = ['ok', 'warn', 'fail', 'skip'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export interface Check {
  id: CheckId;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface DoctorMachine {
  platform: string;
  nodeVersion: string;
  execPath: string;
  rootDir: string;
  envFile: string;
  /** where each agent looks for skills */
  skillsDirs: Record<Agent, string>;
  /** ~/.codex/config.toml */
  codexConfig: string;
  binDir: string;
  apps: { chrome: string[]; terminals: Record<Terminal, string> };
}

export interface DoctorConfig {
  dataDir: string;
  codeRoot: string | undefined;
  chromeDir: string;
  agents: AgentSetup;
  editor: Editor;
  editorBin: string;
  terminal: Terminal;
  port: number;
  profilePath: string;
  profileSource: string | undefined;
  jiraFiles: JiraFiles;
}

export type Health = 'free' | 'worklog' | 'other';

export interface DoctorProbes {
  run(bin: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }>;
  readPassword: ReadPassword;
  jiraRequest: JiraRequest;
  health(port: number): Promise<Health>;
}

const MIN_NODE = 24;
const HEALTH_TIMEOUT_MS = 2000;
const TERMINAL_LABELS: Record<Terminal, string> = { warp: 'Warp', iterm: 'iTerm2', terminal: 'Terminal' };
const JIRA_FIXES: Record<JiraErrorKind, string> = {
  token: 'создай новый токен: INSTALL.md, раздел про токен Jira',
  cert: 'сертификат не тот, истёк или не открывается: INSTALL.md, раздел про сертификат Jira',
  'server-cert': 'Node не доверяет сертификату сервера Jira: положи корневой сертификат компании в файл из WORKLOG_JIRA_CA (~/.config/worklog/jira-ca.crt)',
  network: 'нет связи с Jira: включи VPN и повтори',
  other: 'повтори позже; не проходит — посмотри logs/server.log',
};
const AUTOMATION_NOTE = 'при первом запуске агента macOS спросит, можно ли управлять терминалом («Автоматизация») — нажать «Разрешить»';

function check(id: CheckId, status: CheckStatus, detail: string, fix?: string): Check {
  return fix === undefined ? { id, status, detail } : { id, status, detail, fix };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(file: string): Promise<boolean> {
  if (!path.isAbsolute(file)) return false;
  try {
    await access(file, constants.X_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export function defaultMachine(rootDir: string, envFile: string): DoctorMachine {
  const home = homedir();
  return {
    platform: process.platform,
    nodeVersion: process.versions.node,
    execPath: process.execPath,
    rootDir,
    envFile,
    skillsDirs: { claude: process.env.CLAUDE_SKILLS_DIR || path.join(home, '.claude', 'skills'), codex: process.env.CODEX_SKILLS_DIR || path.join(home, '.agents', 'skills') },
    codexConfig: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'),
    binDir: process.env.WORKLOG_BIN_DIR || path.join(home, '.local', 'bin'),
    apps: {
      chrome: ['/Applications/Google Chrome.app', path.join(home, 'Applications', 'Google Chrome.app')],
      terminals: { warp: '/Applications/Warp.app', iterm: '/Applications/iTerm.app', terminal: '/System/Applications/Utilities/Terminal.app' },
    },
  };
}

export const defaultProbes: DoctorProbes = {
  run: (bin, args, cwd) =>
    new Promise(resolve => {
      execFile(bin, args, { cwd, timeout: 10_000 }, (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr });
      });
    }),
  readPassword: keychainPassword,
  jiraRequest: httpsRequest,
  health: worklogHealth,
};

/** who answers on the port: nobody, Worklog, or some other program */
export function worklogHealth(port: number): Promise<Health> {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: HEALTH_TIMEOUT_MS }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve(isWorklogHealth(body) ? 'worklog' : 'other'));
      res.on('error', () => resolve('other'));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', error => resolve(isErrorCode(error, 'ECONNREFUSED') ? 'free' : 'other'));
  });
}

function isWorklogHealth(body: string): boolean {
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) && value.ok === true && typeof value.clients === 'number';
  } catch {
    return false;
  }
}

export async function runDoctor(machine: DoctorMachine, config: DoctorConfig | string, probes: DoctorProbes): Promise<Check[]> {
  const checks: Check[] = [
    machine.platform === 'darwin' ? check('macos', 'ok', 'macOS') : check('macos', 'fail', `нужна macOS, а это ${machine.platform}`),
    nodeCheck(machine),
    await gitCheck(probes),
  ];
  if (typeof config === 'string') {
    checks.push(check('env', 'fail', config, 'worklog config set <ИМЯ> <значение>'));
    const later = CHECK_IDS.filter(id => !checks.some(done => done.id === id));
    return [...checks, ...later.map(id => check(id, 'skip', 'сначала исправь настройки'))];
  }
  const { profile, error: profileError } = await loadProfile(config.profilePath);
  // the certificate, token and Jira checks would each read the same keychain items
  const passwords = new Map<string, Promise<string | null>>();
  const readOnce: ReadPassword = service => {
    const known = passwords.get(service);
    if (known !== undefined) return known;
    const reading = probes.readPassword(service);
    passwords.set(service, reading);
    return reading;
  };
  const once: DoctorProbes = { ...probes, readPassword: readOnce };
  const jiraChecks = (async (): Promise<Check[]> => {
    const p12 = await p12Check(profile?.jira, config.jiraFiles, once);
    const token = await tokenCheck(profile?.jira, config.jiraFiles, once);
    return [p12, token, await jiraCheck(profile?.jira, config.jiraFiles, once, p12, token)];
  })();
  const web = exists(path.join(machine.rootDir, 'web', 'dist', 'web', 'browser', 'index.html')).then(built =>
    built ? check('web', 'ok', 'фронт собран') : check('web', 'fail', 'фронт не собран', `в ${machine.rootDir}: npm ci && npm ci --prefix web && npm run build`),
  );
  const [chrome, agents, env, codeRoot, webCheck, jira, port, skills, codexData, cli, terminal, editor, data] = await Promise.all([
    chromeCheck(machine, config),
    agentsCheck(config.agents),
    envCheck(machine),
    codeRootCheck(config, probes),
    web,
    jiraChecks,
    portCheck(config.port, probes),
    skillsCheck(machine, config.agents),
    codexDataCheck(machine, config),
    cliCheck(machine),
    terminalCheck(machine, config.terminal),
    editorCheck(config),
    dataCheck(config.dataDir),
  ]);
  checks.push(chrome, agents, env, codeRoot, profileCheck(config, profile, profileError), webCheck, ...jira, port, skills, codexData, cli, terminal, editor, data);
  return checks;
}

function nodeCheck(machine: DoctorMachine): Check {
  const major = Number(machine.nodeVersion.split('.')[0]);
  const detail = `${machine.nodeVersion} (${machine.execPath})`;
  return major >= MIN_NODE ? check('node', 'ok', detail) : check('node', 'fail', `${detail}, нужен ${MIN_NODE}+`, `поставь Node ${MIN_NODE}+ и укажи его: worklog config set WORKLOG_NODE <полный путь к node>`);
}

async function gitCheck(probes: DoctorProbes): Promise<Check> {
  const result = await probes.run('git', ['--version']);
  return result.code === 0 ? check('git', 'ok', result.stdout.trim()) : check('git', 'fail', 'git не найден', 'xcode-select --install');
}

async function chromeCheck(machine: DoctorMachine, config: DoctorConfig): Promise<Check> {
  const apps = await Promise.all(machine.apps.chrome.map(exists));
  if (!apps.some(Boolean)) return check('chrome', 'fail', 'Google Chrome не установлен', 'поставь Google Chrome');
  if (!(await exists(config.chromeDir))) return check('chrome', 'fail', `нет папки профиля Chrome ${config.chromeDir}`, 'открой Chrome хотя бы раз или укажи папку: worklog config set WORKLOG_CHROME_DIR <папка>');
  return check('chrome', 'ok', config.chromeDir);
}

/** why the program cannot run, or null */
async function binProblem(bin: string, name: string): Promise<string | null> {
  if (await isExecutable(bin)) return null;
  return path.isAbsolute(bin) ? `${bin} не найден или не запускается` : `нужен полный путь к ${name}, а записано «${bin}»`;
}

async function editorCheck(config: DoctorConfig): Promise<Check> {
  const name = EDITOR_BINS[config.editor];
  const problem = await binProblem(config.editorBin, name);
  return problem === null ? check('editor', 'ok', config.editorBin) : check('editor', 'fail', problem, `worklog config set WORKLOG_EDITOR_BIN "$(command -v ${name})"`);
}

const AGENT_BIN_SETTINGS: Record<Agent, SettingName> = { claude: 'WORKLOG_CLAUDE_BIN', codex: 'WORKLOG_CODEX_BIN' };

/** the main agent first, then the other one if it is set; each needs a full path to a program that runs */
async function agentsCheck(setup: AgentSetup): Promise<Check> {
  const order = [setup.main, ...installedAgents(setup.bins).filter(agent => agent !== setup.main)];
  const labels: string[] = [];
  for (const agent of order) {
    const bin = setup.bins[agent];
    const problem = bin === undefined ? `нет пути к ${agent}` : await binProblem(bin, agent);
    if (bin === undefined || problem !== null) return check('agents', 'fail', problem ?? '', `worklog config set ${AGENT_BIN_SETTINGS[agent]} "$(command -v ${agent})"`);
    // fnm puts every shell's PATH into a folder that disappears with the shell
    if (bin.includes('/fnm_multishells/')) {
      return check('agents', 'fail', `путь ${bin} пропадёт вместе с оболочкой`, `worklog config set ${AGENT_BIN_SETTINGS[agent]} "$(realpath "$(command -v ${agent})")"`);
    }
    labels.push(agent === setup.main ? `${agent} (основной)` : agent);
  }
  return check('agents', 'ok', labels.join(', '));
}

async function envCheck(machine: DoctorMachine): Promise<Check> {
  let text: string;
  try {
    text = await readFile(machine.envFile, 'utf8');
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return check('env', 'warn', `нет файла настроек ${machine.envFile}`, 'worklog config set WORKLOG_CODE_ROOT <папка проекта>');
    return check('env', 'fail', `${machine.envFile}: ${errorMessage(error)}`);
  }
  const unknown = Object.keys(parseEnvFile(text)).filter(name => !isSettingName(name));
  if (unknown.length > 0) return check('env', 'warn', `неизвестные настройки: ${unknown.join(', ')}`, `исправь или удали эти строки в ${machine.envFile}`);
  return check('env', 'ok', machine.envFile);
}

async function codeRootCheck(config: DoctorConfig, probes: DoctorProbes): Promise<Check> {
  const fix = 'worklog config set WORKLOG_CODE_ROOT <полный путь к папке рабочего проекта>';
  if (config.codeRoot === undefined) return check('code-root', 'fail', 'папка проекта не задана', fix);
  const result = await probes.run('git', ['-C', config.codeRoot, 'rev-parse', '--is-inside-work-tree']);
  if (result.code !== 0) return check('code-root', 'fail', `${config.codeRoot} — не git-репозиторий`, fix);
  return check('code-root', 'ok', config.codeRoot);
}

function profileCheck(config: DoctorConfig, profile: Profile | null, error: string | null): Check {
  if (error !== null) return check('profile', 'fail', error, 'worklog profile update или worklog profile fetch <ссылка>');
  if (profile === null) return check('profile', 'warn', `нет профиля ${config.profilePath}: Worklog работает без Jira, веток и стендов`, 'worklog profile fetch <ссылка на профиль компании>');
  if (config.profileSource === undefined) return check('profile', 'warn', `версия ${profile.version}, источник не записан — «обнови профиль» не сработает`, 'worklog profile fetch <ссылка на профиль компании>');
  return check('profile', 'ok', `версия ${profile.version}, источник ${config.profileSource}`);
}

async function p12Check(jira: ProfileJira | undefined, files: JiraFiles, probes: DoctorProbes): Promise<Check> {
  if (jira === undefined) return check('p12', 'skip', 'в профиле нет Jira');
  if (!jira.clientCert) return check('p12', 'skip', 'Jira пускает без сертификата');
  const fix = 'INSTALL.md, раздел про сертификат Jira';
  let pfx: Buffer;
  try {
    pfx = await readFile(files.p12Path);
  } catch {
    return check('p12', 'fail', `нет сертификата ${files.p12Path}`, fix);
  }
  const mode = (await stat(files.p12Path)).mode & 0o777;
  if ((mode & 0o077) !== 0) return check('p12', 'fail', `сертификат доступен другим (права ${mode.toString(8)})`, `chmod 600 '${files.p12Path}'`);
  const passphrase = await probes.readPassword(files.keychainService);
  if (passphrase === null) return check('p12', 'fail', `нет пароля от сертификата в связке ключей (${files.keychainService})`, fix);
  try {
    tls.createSecureContext({ pfx, passphrase });
  } catch (error) {
    const legacy = /unsupported/i.test(errorMessage(error));
    return check('p12', 'fail', legacy ? 'Node не открывает сертификат старого формата (RC2)' : 'сертификат не открывается этим паролем', legacy ? `перепакуй: ${fix}` : fix);
  }
  return check('p12', 'ok', files.p12Path);
}

async function tokenCheck(jira: ProfileJira | undefined, files: JiraFiles, probes: DoctorProbes): Promise<Check> {
  if (jira === undefined) return check('token', 'skip', 'в профиле нет Jira');
  const token = (await probes.readPassword(files.tokenService))?.trim() ?? '';
  if (token === '') return check('token', 'fail', `нет токена в связке ключей (${files.tokenService})`, 'INSTALL.md, раздел про токен Jira');
  return check('token', 'ok', `в связке ключей (${files.tokenService})`);
}

async function jiraCheck(jira: ProfileJira | undefined, files: JiraFiles, probes: DoctorProbes, p12: Check, token: Check): Promise<Check> {
  if (jira === undefined) return check('jira', 'skip', 'в профиле нет Jira');
  if (p12.status === 'fail' || token.status === 'fail') return check('jira', 'skip', 'сначала сертификат и токен');
  try {
    return check('jira', 'ok', `отвечает, пользователь ${await jiraUser(jiraConfig(jira, files), probes.readPassword, probes.jiraRequest)}`);
  } catch (error) {
    if (error instanceof JiraError) return check('jira', 'fail', `Jira: ${error.message}`, JIRA_FIXES[error.kind]);
    return check('jira', 'fail', `Jira: ${errorMessage(error)}`, JIRA_FIXES.other);
  }
}

async function portCheck(port: number, probes: DoctorProbes): Promise<Check> {
  const health = await probes.health(port);
  if (health === 'free') return check('port', 'ok', `${port} свободен`);
  if (health === 'worklog') return check('port', 'ok', `${port}: работает Worklog`);
  return check('port', 'fail', `порт ${port} занят другой программой`, `посмотри, кто его держит: lsof -nP -iTCP:${port} -sTCP:LISTEN`);
}

/** where the link points, null when there is no link; a plain file or folder reads as '' */
async function linkTarget(file: string): Promise<string | null> {
  try {
    return (await lstat(file)).isSymbolicLink() ? await readlink(file) : '';
  } catch {
    return null;
  }
}

async function skillsCheck(machine: DoctorMachine, setup: AgentSetup): Promise<Check> {
  const entries = await readdir(path.join(machine.rootDir, 'skills'), { withFileTypes: true });
  const names = entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
  const missing: string[] = [];
  const foreign: string[] = [];
  for (const agent of installedAgents(setup.bins)) {
    const dir = machine.skillsDirs[agent];
    for (const name of names) {
      const target = await linkTarget(path.join(dir, name));
      if (target === null) missing.push(path.join(dir, name));
      else if (target !== path.join(machine.rootDir, 'skills', name)) foreign.push(path.join(dir, name));
    }
  }
  if (foreign.length > 0) return check('skills', 'fail', `не из этого клона: ${foreign.join(', ')}`, 'спроси коллегу, что делать с этими скиллами; без его ответа не трогать');
  if (missing.length > 0) return check('skills', 'fail', `не установлены: ${missing.join(', ')}`, `в ${machine.rootDir}: npm run skills`);
  return check('skills', 'ok', installedAgents(setup.bins).map(agent => machine.skillsDirs[agent]).join(', '));
}

/** Codex keeps the CLI in its sandbox: without the data folder among its writable roots it asks before every record */
async function codexDataCheck(machine: DoctorMachine, config: DoctorConfig): Promise<Check> {
  if (config.agents.bins.codex === undefined) return check('codex-data', 'skip', 'Codex не установлен');
  const text = await readFile(machine.codexConfig, 'utf8').catch(() => '');
  const listed = text.includes('writable_roots') && (text.includes(JSON.stringify(config.dataDir)) || text.includes(`'${config.dataDir}'`));
  if (listed) return check('codex-data', 'ok', `Codex пишет в ${config.dataDir} без вопросов`);
  return check('codex-data', 'warn', 'Codex будет спрашивать разрешение на каждую запись в данные Worklog', `INSTALL.md, шаг 7: ${config.dataDir} в writable_roots в ${machine.codexConfig}`);
}

async function cliCheck(machine: DoctorMachine): Promise<Check> {
  const link = path.join(machine.binDir, 'worklog');
  const target = await linkTarget(link);
  if (target === null) return check('cli', 'fail', `нет ${link}`, `в ${machine.rootDir}: npm run skills`);
  if (target !== path.join(machine.rootDir, 'bin', 'worklog')) return check('cli', 'fail', `${link} не из этого клона`, 'спроси коллегу, что это за файл; без его ответа не трогать');
  return check('cli', 'ok', link);
}

async function terminalCheck(machine: DoctorMachine, terminal: Terminal): Promise<Check> {
  const app = machine.apps.terminals[terminal];
  if (!(await exists(app))) return check('terminal', 'fail', `${TERMINAL_LABELS[terminal]} не установлен (${app})`, 'worklog config set WORKLOG_TERMINAL warp|iterm|terminal — из установленных');
  return check('terminal', 'ok', terminal === 'warp' ? TERMINAL_LABELS[terminal] : `${TERMINAL_LABELS[terminal]}; ${AUTOMATION_NOTE}`);
}

async function dataCheck(dataDir: string): Promise<Check> {
  if (!(await exists(dataDir))) return check('data', 'fail', `нет папки данных ${dataDir}`, 'worklog data init');
  try {
    await new Store(dataDir).read();
  } catch (error) {
    return check('data', 'fail', `данные не читаются: ${errorMessage(error)}`);
  }
  const state = await dataRepoState(dataDir);
  if (state === 'own') return check('data', 'ok', dataDir);
  if (state === 'shared') return check('data', 'warn', `${dataDir} лежит в git кода, а не в своём`);
  return check('data', 'fail', `у ${dataDir} нет своего git`, 'worklog data init');
}

export function formatChecks(checks: readonly Check[]): string {
  const marks: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗', skip: '–' };
  const lines = checks.flatMap(item => {
    const line = `${marks[item.status]} ${item.id}: ${item.detail}`;
    return item.fix !== undefined && (item.status === 'fail' || item.status === 'warn') ? [line, `    → ${item.fix}`] : [line];
  });
  const fails = checks.filter(item => item.status === 'fail').length;
  const warns = checks.filter(item => item.status === 'warn').length;
  lines.push(fails > 0 ? `Ошибок: ${fails}` : warns > 0 ? `Ошибок нет, предупреждений: ${warns}` : 'Всё в порядке');
  return lines.join('\n');
}
