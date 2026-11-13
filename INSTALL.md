# Installing Worklog — instructions for the agent

You are an AI coding agent (Claude Code or Codex) installing Worklog for a colleague. Usually they started you in their work project and wrote one line: «установи worklog по инструкции https://raw.githubusercontent.com/levonka/worklog/main/INSTALL.md. данные о компании бери здесь <profile link>». If you were given only the repository link, read this file before cloning anything. The profile link points to the company profile, a JSON file in the company's GitLab. Keep it for step 3. If there is no profile link, ask once whether the company has a profile; without one Worklog is a plain tracker: skip step 3, step 6 and the profile links of step 8. Jira can also be put off (step 6) and the editor left out (step 4).

## Rules

- Talk to the colleague in Russian. Ask one question at a time and say what you are about to do before each step.
- **Never see a secret.** Do not run `security find-generic-password … -w` with output that reaches you, do not print files that hold a token or a password, and do not take screenshots or read the page while a Jira token is shown. The colleague types the certificate password; the token reaches the keychain through the clipboard (step 6).
- **Nothing irreversible or foreign without asking.** Do not overwrite or delete skills, data, `~/.claude/settings.json` or files you did not create. When something is in the way, show it and ask.
- **Check every step.** After each step run `doctor` (`<clone>/bin/worklog doctor --json` until step 7, `~/.local/bin/worklog doctor --json` after) and go on only when the checks of that step (table below) pass: `ok` or `skip` (the check does not apply: no Jira in the profile, Codex is not installed). A `warn` passes only where the step says so; a `fail` never does. The output is `{ "ok": …, "checks": [{ "id", "status", "detail", "fix" }] }`; `status` is `ok`, `warn`, `fail` or `skip`; `fix` says what to do.
- **Browser steps.** If you have a browser tool (Claude in Chrome or another), do the browser steps yourself, except where a step says the colleague acts. Without one, tell the colleague exactly what to open and do, and wait until they say it is done.
- **Every step can be repeated.** «продолжи установку worklog» means: run `doctor` and continue from the first step whose checks do not pass. If `p12`, `token` and `jira` say «Jira отложена», ask once whether to set Jira up now (step 6).
- **Dead end.** If a step cannot be fixed, stop and tell the colleague what broke and whom to ask: no access to the profile — the profile's author; Jira does not let them in — check the certificate and the VPN, then ask whoever issues Jira certificates, and offer to put Jira off (step 6). Do not work around the problem.

| Step | doctor checks |
|---|---|
| 0. Prerequisites | `macos`, `node`, `git` |
| 1. Project folder | `code-root` |
| 3. Profile | `profile` |
| 4. Machine settings | `env`, `chrome`, `agents`, `terminal`, `editor` |
| 5. Build | `web` |
| 6. Jira | `p12`, `token`, `jira` |
| 7. Skills and CLI | `skills`, `codex-data`, `cli` |
| 8. Data | `data` |
| 10. Final check | all, `port` says `работает Worklog` |

## Install

**0. Prerequisites.** macOS, Node 24+, git, Google Chrome, Claude Code (`claude`) or Codex (`codex`). Check with `node --version`, `git --version`, `ls -d "/Applications/Google Chrome.app"`, `command -v claude`, `command -v codex`. If something is missing, say how to install it (Node — Homebrew or fnm; git — `xcode-select --install`) and install it only after the colleague agrees.

**1. Project folder.** Show the current folder and ask: «это папка рабочего проекта?». Say why it is asked: tasks handed to the agent open there, a branch's MR is found there with `git ls-remote origin`, and file paths in knowledge notes are relative to it; Worklog writes nothing into it. It must be a git repository (`git -C <folder> rev-parse --show-toplevel`). Then: `<clone>/bin/worklog config set WORKLOG_CODE_ROOT <full path>` (before the clone exists, remember the path and run this right after step 2).

**2. Where to clone.** Ask, offering the sibling folder `../worklog` of the project folder. Never clone inside a git repository. If you already cloned somewhere else (for example into the current folder before reading this file), move the clone to the chosen place after asking and remove what is left. If the chosen folder exists and is not empty, ask. Clone: `git clone <GitHub link> <folder>`.

**3. Profile.** `<clone>/bin/worklog profile fetch <profile link>`. It fetches the file through git over SSH, checks it and saves `~/.config/worklog/profile.json`, remembering the link for «обнови профиль». If SSH fails, the file comes through the browser, where the colleague is logged in to GitLab: the raw view of the link (`/-/raw/` instead of `/-/blob/`). With a browser tool read it and save the text to a temporary file; without one ask the colleague to open the raw view and save the page (⌘S) to `~/Downloads`. Then run `profile fetch --from <file> <profile link>`. A full local path instead of a link also works. An invalid profile changes nothing; show the error to the colleague — the profile's author fixes it. Without a profile `profile` stays `warn` «нет профиля», and that passes.

**4. Machine settings.** Each with `worklog config set <NAME> <value>`, full paths only:
- `WORKLOG_NODE` — a stable node path: Homebrew `/opt/homebrew/bin/node`, fnm `~/.local/share/fnm/aliases/default/bin/node` (expanded), nvm `~/.nvm/versions/node/<version>/bin/node`. Never a path under `fnm_multishells`: it disappears with the shell.
- `WORKLOG_AGENT` — you yourself: `claude` or `codex`.
- `WORKLOG_CLAUDE_BIN` and `WORKLOG_CODEX_BIN` — `command -v claude`, `command -v codex`. A path under `fnm_multishells` (a tool installed with npm under fnm) disappears with the shell: take `realpath` of it instead. Set yours; if the other one is found too, ask whether the colleague uses it as well and set it only on a yes. Both set: skills go to both, the daily summary reads the sessions of both, and the colleague picks the agent when handing over a task.
- `WORKLOG_TERMINAL` — offer the installed ones: `warp` (`/Applications/Warp.app`), `iterm` (`/Applications/iTerm.app`), `terminal` (always there). Worklog opens a new tab there when the colleague hands a task to an agent.
- `WORKLOG_EDITOR` and `WORKLOG_EDITOR_BIN` — offer the installed ones: `jetbrains` (`webstorm` or `idea`), `vscode` (`code`), `cursor` (`cursor`); the binary from `command -v`. If the shell command is missing: JetBrains Toolbox → settings → «Shell scripts»; VS Code and Cursor → command palette → «Shell Command: Install … in PATH». If the colleague uses none of them, `WORKLOG_EDITOR none` and no `WORKLOG_EDITOR_BIN`: file links in knowledge notes then show as text and do not open; `editor` is `skip`.
- `WORKLOG_GITLAB_USER` — only when the profile has `gitlab`: `ssh -T -p <gitlab.sshPort> git@<gitlab.sshHost>` answers «Welcome to GitLab, @login!». If it does not, ask the colleague for their GitLab login.

**5. Build.** In the clone: `npm ci`, `npm ci --prefix web`, `npm run build`.

**6. Jira** — only when the profile has `jira`.
- **Put off.** If the colleague has no certificate or token yet, or Jira does not let them in now, offer to finish without Jira: `worklog config set WORKLOG_JIRA off`. Worklog works without it — no ticket statuses, stages are set by hand — and `p12`, `token`, `jira` become `skip` «Jira отложена». Coming back: `worklog config set WORKLOG_JIRA on`, this step, then restart the server if it runs (CLAUDE.md of the clone).
- **Certificate** (when `jira.clientCert` is `true`). Ask where their `.p12` lies, then `mkdir -p -m 700 ~/.config/worklog && install -m 600 <file> ~/.config/worklog/jira.p12`. For the password, write a script and open it in Terminal — the colleague types the password there and you never see it:
  ```bash
  f="$TMPDIR/worklog-p12-password.command"
  printf '%s\n' '#!/bin/zsh' 'security add-generic-password -U -s worklog-jira-p12 -a "$USER" -w && echo "Готово, окно можно закрыть"' > "$f"
  chmod 700 "$f" && open "$f"
  ```
  Tell the colleague to type the certificate password twice in the new window, then delete `$f`. If `doctor` says the certificate has the old format (RC2), repack it with the same password. Ask the colleague first and make sure their original `.p12` is still where they keep it: it is the copy to go back to. It needs OpenSSL 3 (`brew install openssl@3`); macOS's own `/usr/bin/openssl` is LibreSSL and writes the old format again. The password goes through a variable and is never printed; `jira.p12` is replaced only once the new file is written, and the decrypted key in `jira.tmp.pem` is removed whatever happens:
  ```bash
  OPENSSL="$(brew --prefix openssl@3)/bin/openssl"
  cd ~/.config/worklog && umask 077 && export P12PASS="$(security find-generic-password -s worklog-jira-p12 -w)" && "$OPENSSL" pkcs12 -legacy -in jira.p12 -nodes -passin env:P12PASS -out jira.tmp.pem && "$OPENSSL" pkcs12 -export -in jira.tmp.pem -out jira.new.p12 -passout env:P12PASS && mv jira.new.p12 jira.p12; rm -f jira.tmp.pem jira.new.p12; unset P12PASS
  ```
- **Token.** Open `<jira.url>/secure/ViewProfile.jspa?selectedTab=com.atlassian.pats.pats-plugin:jira-user-personal-access-tokens` (with a browser tool, or ask the colleague to), press «Create token» and type the name `worklog`. Then stop acting in the browser and tell the colleague: «Нажми Create, затем Copy в окне с токеном и закрой это окно. Напиши, когда готово». Until they answer, do not take screenshots and do not read the page: the token would land in the transcript. Then:
  ```bash
  [[ $(pbpaste) =~ ^[A-Za-z0-9+/=_-]{20,}$ ]] && echo "похоже на токен" || echo "в буфере не токен"
  security add-generic-password -U -s worklog-jira-token -a "$USER" -w "$(pbpaste)" && pbcopy < /dev/null
  ```
  If the clipboard no longer holds the token, ask the colleague to revoke the `worklog` token on the same page and repeat.
- If `jira` says the server certificate is not trusted, ask the colleague for the company's root certificate and save it as `~/.config/worklog/jira-ca.crt`. A network error usually means the VPN is off.

**7. Skills and CLI.** In the clone: `npm run skills`. It links the skills into `~/.claude/skills` (if `~/.claude` exists) and `~/.agents/skills` (if `~/.codex` exists) and the CLI to `~/.local/bin/worklog`, and skips a name that is already taken by something else — then show it to the colleague and ask. Permissions, each only with the colleague's yes and keeping everything else in the file:
- Claude Code: the rule `Bash(~/.local/bin/worklog:*)` in `permissions.allow` of `~/.claude/settings.json`.
- Codex: its sandbox lets commands write only into the project, so the CLI cannot write Worklog's data. Add the full path of `<clone>/data` to `writable_roots` in the `[sandbox_workspace_write]` table of `~/.codex/config.toml` (create the table if there is none; add to the list if it exists). Without it Codex asks before every record — say so if the colleague declines; `codex-data` then stays `warn`, and that passes.

**8. Data.** `~/.local/bin/worklog data init` (its own git inside `data/`). With a profile also `~/.local/bin/worklog quicklink import` (its sidebar links) and `~/.local/bin/worklog data commit --message "Ссылки из профиля"`. Run `quicklink import` only here and on a direct request: after that the links are the colleague's own.

**9. Launcher.** In the clone: `npm run launcher` — `Worklog.app` appears on the Desktop. It replaces only a launcher of its own; if it says another `Worklog.app` is there, show it to the colleague and ask.

**10. Final check.** `open ~/Desktop/Worklog.app`; a Chrome window with Worklog opens. Then `doctor`: every check passes, `port` says `работает Worklog`, `jira` is `ok` when the profile has Jira and it is not put off. With Terminal or iTerm2 as the terminal, ask the colleague to hand one task to the agent from the window once («✦ Поручить агенту» → «Вопрос», any text): macOS asks whether Worklog may control the terminal («Автоматизация») — the answer must be «Разрешить». Close that tab afterwards. Tell the colleague what changed on their machine: the list from README «Что появляется на машине», only what this install really did, with the real paths (the clone, the skill folders it linked into). Then that «обнови worklog», «обнови профиль worklog», «worklog не работает» and «удали worklog» work from any session, and that the end-of-session review is `/worklog` in Claude Code and `$worklog` in Codex.

## Update Worklog («обнови worklog»)

The window runs the same steps by itself from its «Обновить Worklog» button (`server/update-main.ts`, the run in `logs/update.json`, its output in `logs/update.log`); the phrase works as below either way.

1. `~/.local/bin/worklog data commit` — a snapshot of the data before anything changes.
2. `git -C <clone> status --porcelain` — if the code has local changes, stop and ask.
3. `git -C <clone> pull --ff-only`.
4. In the clone: `npm ci`, `npm ci --prefix web`, `npm run build`.
5. If the server runs (`lsof -tiTCP:4317 -sTCP:LISTEN` prints a pid), restart it as `CLAUDE.md` of the clone describes; the open window reconnects by itself.
6. `npm run skills` in the clone.
7. `doctor`, then tell the colleague what changed (`git log` of the pulled range, one line each).

## Update the profile («обнови профиль worklog»)

`~/.local/bin/worklog profile update`, then restart the server if it runs (step 5 above). Sidebar links are left alone; when the colleague asks for the missing ones, `quicklink import` adds only links whose address they do not have yet.

## Uninstall («удали worklog»)

Every step is the colleague's to decide: say what it removes, ask, and skip what they decline. Read `jira.url` from `~/.config/worklog/profile.json` before step 4 deletes it.

1. **Data.** `~/.local/bin/worklog data commit`, then ask whether to keep the data. Offer a copy: `cp -R <clone>/data ~/Documents/worklog-data-<YYYY-MM-DD>`. The copy keeps its own git; put it in place of `data/` of a new clone to get everything back. Go on only once this is answered.
2. **What points at the clone.** Ask the colleague to close the Worklog window, then `zsh <clone>/scripts/uninstall.sh`. It stops this clone's server and removes the skill and CLI links into the clone, `~/Desktop/Worklog.app` when it is this clone's launcher and the Warp tab files of agent runs; anything foreign stays. Show its output.
3. **Permissions.** Remove only what the install added and keep the rest of each file: the rule `Bash(~/.local/bin/worklog:*)` in `permissions.allow` of `~/.claude/settings.json`; the `<clone>/data` path in `writable_roots` of `~/.codex/config.toml`.
4. **Settings and secrets.** `rm -rf ~/.config/worklog` (machine settings, profile, Jira certificates), `security delete-generic-password -s worklog-jira-p12` and `security delete-generic-password -s worklog-jira-token` (a missing item is an error that changes nothing). The token itself stays valid in Jira until the colleague revokes the `worklog` token on `<jira.url>/secure/ViewProfile.jspa?selectedTab=com.atlassian.pats.pats-plugin:jira-user-personal-access-tokens`: say so.
5. **The clone.** Only on a clear yes after step 1: `rm -rf <clone>`. It takes `data/` with it.
6. **Report.** List what was removed, with the real paths. Say what stays for the colleague to remove by hand if they want: the «Автоматизация» permission of the terminal (System Settings → Privacy & Security → Automation) and Node, git or OpenSSL 3 if the install added them.

## Worklog does not work («worklog не работает»)

Run `doctor`, fix the `fail` lines from the top by their `fix`, run `doctor` again after each fix. If everything is `ok` but the problem stays, look at `<clone>/logs/server.log` and tell the colleague what you found.
