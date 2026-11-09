/** commands that must work while the env file is broken, so they never load server/config.ts up front */
export const SETUP_USAGES = {
  'config set': 'config set <NAME> <value>',
  doctor: 'doctor [--json]',
} as const;

export function isSetupCommand(command: string | undefined): boolean {
  return command === 'config' || command === 'doctor';
}
