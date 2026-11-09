/** git that never asks for a password: Worklog runs it without a terminal; the user's ssh setup (core.sshCommand, GIT_SSH_COMMAND, ~/.ssh/config) stays in force */
export function quietGitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0' };
}
