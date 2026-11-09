import { parseArgs } from 'node:util';
import path from 'node:path';
import { SETTINGS, isSettingName, setEnvValue, settingProblem } from '../server/env-file.ts';
import type { DoctorConfig } from '../server/doctor.ts';
import { errorMessage } from '../server/fs-utils.ts';
import type { CliResult } from './commands.ts';
import { SETUP_USAGES } from './setup-commands.ts';

export interface SetupEnv {
  envFile: string;
}

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

export async function runSetup(argv: string[], env: SetupEnv): Promise<CliResult> {
  const [command, ...rest] = argv;
  try {
    if (command === 'config' && rest[0] === 'set') return ok(await configSet(rest.slice(1), env));
    if (command === 'doctor') return await doctor(rest, env);
    return { code: EXIT_USAGE, stdout: '', stderr: `Использование: worklog ${SETUP_USAGES['config set']}\n` };
  } catch (error) {
    return { code: EXIT_ERROR, stdout: '', stderr: `${errorMessage(error)}\n` };
  }
}

function ok(stdout: string): CliResult {
  return { code: 0, stdout: `${stdout}\n`, stderr: '' };
}

async function configSet(args: string[], env: SetupEnv): Promise<string> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  if (positionals.length !== 2) throw new Error(`Использование: worklog ${SETUP_USAGES['config set']}`);
  const [name, value] = positionals;
  if (!isSettingName(name)) throw new Error(`Неизвестная настройка ${name} (известные: ${SETTINGS.join(', ')})`);
  const problem = value === '' ? null : settingProblem(name, value);
  if (problem !== null) throw new Error(`Некорректное значение ${name}: ${value} (${problem})`);
  await setEnvValue(env.envFile, name, value);
  return value === '' ? `${name} убрана из ${env.envFile}` : `${name}=${value} → ${env.envFile}`;
}

/** the settings as the server would take them, or why they cannot be read */
async function doctorConfig(): Promise<DoctorConfig | string> {
  try {
    const config = await import('../server/config.ts');
    return {
      dataDir: config.DATA_DIR,
      codeRoot: config.CODE_ROOT,
      chromeDir: config.CHROME_DIR,
      agents: config.AGENT_SETUP,
      editor: config.EDITOR,
      editorBin: config.EDITOR_BIN,
      terminal: config.TERMINAL,
      port: config.PORT,
      profilePath: config.PROFILE_PATH,
      profileSource: config.PROFILE_SOURCE,
      jiraFiles: config.JIRA_FILES,
    };
  } catch (error) {
    return errorMessage(error);
  }
}

async function doctor(args: string[], env: SetupEnv): Promise<CliResult> {
  const { values, positionals } = parseArgs({ args, options: { json: { type: 'boolean' } }, allowPositionals: true, strict: true });
  if (positionals.length > 0) return { code: EXIT_USAGE, stdout: '', stderr: `Использование: worklog ${SETUP_USAGES.doctor}\n` };
  const { defaultMachine, defaultProbes, formatChecks, runDoctor } = await import('../server/doctor.ts');
  const checks = await runDoctor(defaultMachine(ROOT_DIR, env.envFile), await doctorConfig(), defaultProbes);
  const failed = checks.some(item => item.status === 'fail');
  const stdout = values.json === true ? JSON.stringify({ ok: !failed, checks }, null, 2) : formatChecks(checks);
  return { code: failed ? EXIT_ERROR : 0, stdout: `${stdout}\n`, stderr: '' };
}
