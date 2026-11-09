import { envFilePath } from '../server/env-file.ts';
import type { CliResult } from './commands.ts';
import { isSetupCommand, runSetup } from './setup.ts';

async function withConfig(argv: string[]): Promise<CliResult> {
  let config: typeof import('../server/config.ts');
  try {
    config = await import('../server/config.ts');
  } catch (error) {
    return { code: 1, stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\nИсправить: worklog config set <ИМЯ> <значение>, проверить: worklog doctor\n` };
  }
  const { loadProfile } = await import('../server/profile.ts');
  const { runCli } = await import('./commands.ts');
  const { profile, error } = await loadProfile(config.PROFILE_PATH);
  if (error !== null) process.stderr.write(`${error}\n`);
  return runCli(argv, {
    dataDir: config.DATA_DIR,
    chromeDir: config.CHROME_DIR,
    codeRoot: config.CODE_ROOT,
    profile,
    envFile: config.ENV_FILE,
    profilePath: config.PROFILE_PATH,
    profileSource: config.PROFILE_SOURCE,
    gitlabUser: config.GITLAB_USER,
  });
}

const argv = process.argv.slice(2);
const { code, stdout, stderr } = isSetupCommand(argv[0]) ? await runSetup(argv, { envFile: envFilePath() }) : await withConfig(argv);
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exitCode = code;
