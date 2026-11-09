# Worklog

A personal local work tracker: directions (groups of Jira tickets, links and an event feed) on a status board, a continuous todo list, quick links, the daily stand-up note, history and a knowledge base. One user per machine, macOS, one Chrome `--app` window kept open all day, started from `~/Desktop/Worklog.app`. Data never leaves the machine. Everything about a company (Jira, projects, branches, stands, GitLab, sidebar links) comes from its profile; without one Worklog is a plain tracker.

Talk to the user in Russian.

## Read first

- Spec: `docs/specs/worklog.md` — goals, anti-goals, behaviour, data model.
- Installing, updating and repairing: `INSTALL.md` (written for an agent) and `worklog doctor`.
- Visual reference: the app itself.

## Working from another folder

Sessions usually start in the user's work project, where this file is not loaded. When changing Worklog from such a session: the clone is where `~/.local/bin/worklog` points (`readlink` gives `<clone>/bin/worklog`); run commands as `cd <clone> && …`, use absolute paths, and never touch the work project. Its rules do not apply here; the rules below do.

## Layout

- `shared/model.ts` — the only model file, no imports; used by server, CLI and web (`@worklog/model`). Types, `as const` arrays, pure functions.
- `server/` — `node:http` on 127.0.0.1:4317: `store.ts` (mkdir lock + atomic writes; dailies and the daily draft too), `sessions.ts` (reads Claude Code transcripts), `summarizer.ts` (prompt + `claude -p` or `codex exec`), `daily.ts` (runs the summary in the background), `api.ts`, `http.ts` (Host and Content-Type checks), `live.ts` (SSE `/api/live` + idle shutdown), `static.ts` (serves `web/dist/web/browser` from disk), `main.ts`, `config.ts` (settings).
- `server/config.ts` — every setting comes from the environment, then `~/.config/worklog/env` (`WORKLOG_ENV_FILE`, read by `server/env-file.ts`: `WORKLOG_NAME=value` lines, names in `SETTINGS`), then a default: node, the project folder (no default: without it opening files, the agent and MR links are off), `claude`, terminal (`warp`/`iterm`/`terminal`), editor (`jetbrains`/`vscode`/`cursor`). The shell scripts read the same file through `scripts/settings.sh` (`worklog_setting NAME`): node, the port, which agents are set.
- `server/profile.ts` — loads the company profile `~/.config/worklog/profile.json` (`WORKLOG_PROFILE`): Jira, projects and their platform labels, branch format, segments, stand/build/Storybook templates, GitLab, link hosts, starter links. Its type and `parseProfile` live in the model; every function that needs the company takes `profile: Profile | null`. `Store` gets it in its options, the frontend from `GET /api/profile` through `ProfileStore`.
- Repeating todos: rules in `data/repeats.json`, applied by the server every 5 minutes and by `state`/`todo list`.
- `server/note-file.ts` — knowledge notes as `data/notes/<id>.md` (JSON-valued metadata between `---`, then the body); `server/code-files.ts` — broken-file check and opening a file in the chosen editor on its line (`POST /api/open-file`; JetBrains `--line`, VS Code and Cursor `--goto`).
- `server/agent-launch.ts` — an agent run: the prompt in `data/runs/<id>.md`, then the chosen terminal: Warp through a tab config in `~/.warp/tab_configs/worklog-run-<id>.toml` and `open warp://tab_config/…`, iTerm2 and Terminal.app through `osascript` with the command as an argument (macOS asks once for the Automation permission); `GET /api/agent/launcher` tells the window which terminal and folder; the branch check (`git show-ref` in the project folder). The prompt itself is `agentPrompt` in the model.
- `server/chrome-tabs.ts` — reads open Chrome tabs from the profile's SNSS session file (`worklog tabs`).
- `server/jira.ts` — the Jira client (client certificate `.p12` if the profile asks for one + personal token from the keychain, `GET /rest/api/2/search` for status and Segment, `/myself` for `doctor`); `server/jira-poller.ts` — polls every 5 minutes and on `POST /api/jira/refresh`, keeps the Jira state in memory (`GET /api/jira`), writes statuses through `Store.applyJira`. Stand and build links of a branch are pure functions in the model (`envUrl`, `envSegments`, `envCopyText`). `server/merge-requests.ts` — finds a branch's MR with `git ls-remote origin` in the project folder (MR head = branch head) and adds «MR !N» through `Store.applyMergeRequests`; runs with the Jira poll and refresh.
- `cli/` + `bin/worklog` — CLI used by Claude sessions; commands are in `README.md`. `cli/setup.ts` holds `config set` and `doctor`, which never import `server/config.ts` up front, so they work while the env file is broken.
- Agents: `server/agents.ts` resolves the main agent and the installed ones (`WORKLOG_AGENT`, `WORKLOG_CLAUDE_BIN`, `WORKLOG_CODEX_BIN`); `server/codex-sessions.ts` reads Codex rollouts for the daily next to `sessions.ts` (Claude); `summarizer.ts` runs `claude -p` or `codex exec`; the agent window offers both when both are installed. `AGENTS.md` is a link to this file.
- Installation: `INSTALL.md` and the `worklog-setup` skill. `server/doctor.ts` — `worklog doctor` checks with injected probes; `server/profile-source.ts` — `profile fetch|update` (a GitLab file over SSH or a full path); `server/data-git.ts` — `data/` as its own git repository (`data init|commit`).
- `skills/` — Claude Code skills (`worklog-update`, `worklog-chrome-tabs`, `worklog-notes`, `worklog`, `worklog-setup`), linked into `~/.claude/skills/` and `~/.agents/skills/` (Codex) by `npm run skills` (`scripts/install-skills.sh`), which also links `~/.local/bin/worklog` to `bin/worklog`. The skills and the agent prompt call the CLI only as `~/.local/bin/worklog …`, so one permission rule covers them wherever the clone lies. `worklog` is `/worklog` (`$worklog` in Codex) at the end of a session, invoked by the user only (`disable-model-invocation`, and `agents/openai.yaml` for Codex).
- `web/` — Angular 22 (zoneless, standalone, signals, Vitest). This file overrides the generated `web/CLAUDE.md`: keep explicit `ChangeDetectionStrategy.OnPush` and `@Injectable({ providedIn: 'root' })`.
- `web/src/app/agent/` — the task window (`wl-agent-sheet`, a native `<dialog>` opened through `AgentSheet`) and the «агент работает» time.
- `web/src/app/daily/` — the Дейлик screen; `web/src/app/history/` — История; `web/src/app/done/` — Сделано (done directions by month); `web/src/app/knowledge/` — Знания and a direction's notes; `rich-text/` and `link-description/` are shared by notes and link descriptions.
- `scripts/start.sh` — what `Worklog.app` runs: starts the server if needed, raises the open window or opens one. `scripts/build-launcher.sh` builds the app bundle. `scripts/check-leaks.sh` — the leak check (see Rules).
- `data/` — **the user's real data**, its own git repository, ignored by this one.

## Rules

- **Nothing about a company or a person** in code, tests, docs, file names or commit messages: no domains, addresses, ticket keys, project, platform or segment names, Jira workflow, colleagues' names, user paths. All of it lives in the company profile; tests use `TEST_PROFILE` (`shared/test-profile.ts`, `@worklog/test-profile` in `web/`), `example.com` and invented names. On the maintainer's machine `scripts/check-leaks.sh` checks this against a private list (`~/.config/worklog/denylist`) as git hooks; without the list it is skipped.
- Jira secrets live only in `~/.config/worklog/` and the keychain; never in `data/`, logs, API answers, `doctor` output or error texts. Tests never reach the real Jira: they pass a fake `JiraFetch`/`JiraRequest`, and anything that spawns `server/main.ts` sets `WORKLOG_JIRA_P12` to a missing file.
- Tests never read the real profile or machine settings: anything that spawns `server/main.ts`, the CLI or a script sets `WORKLOG_PROFILE` and `WORKLOG_ENV_FILE` to a test file or a missing path, and `CLAUDE_SKILLS_DIR`/`WORKLOG_BIN_DIR` when it looks at skills.
- Never write test data into `data/`. Tests and manual checks use `WORKLOG_DATA_DIR=$(mktemp -d)` and a port other than 4317 (`WORKLOG_PORT`). Checks of the agent launch also set `WORKLOG_OPEN_BIN` to a recorder unless a real terminal tab is wanted. Data changes the user asks for go through `bin/worklog`, not hand edits.
- Port 4317 is the live app. Restart it only as described below.
- Server/CLI TypeScript: erasable syntax only (no enum, namespace, parameter properties), `.ts` import extensions, `import type` for types.
- No `as` casts (`as const` is fine); derive union types from `as const` arrays.
- Angular: standalone, OnPush, `inject()` fields above the fields that use them, signals, selector prefix `wl`.
- CSS: classic BEM. Host class `wl-<name>`; inner elements use the abbreviation (`direction-card` → `dc__title`); modifiers `_mod`, always with the base class; flat SCSS selectors. Colours and sizes from the `--wl-*` tokens in `web/src/styles.scss`.
- Look: native macOS, like Apple's own apps; light and dark via `prefers-color-scheme`.
- UI copy in Russian. Statuses: В работе, Жду, В мерж реквесте, Тестирование, Ждёт релиза, Отложено, Готово; Жду and Отложено are marks over a stage, which comes from Jira for directions with tickets in the profile's projects.
- No external network requests from the frontend (no CDN fonts, no favicon services). External links: `<a target="_blank" rel="noopener">`.
- Texts the app produces for other people (daily text, events, Jira/MR) never mention AI, Claude or agents.
- A new version that changes the data format converts old data when the server starts; `worklog data commit` before an update keeps the snapshot.
- Minimal comments: one short line only where the code cannot say it.
- Test first: write the failing test, watch it fail, then implement.

## Commands

- `npm test` — shared, server, CLI, scripts (`node --test`)
- `npm run typecheck`
- `npm run test:web` — Angular (Vitest)
- `npm run build` — frontend into `web/dist`

Run all four before committing.

## Applying a change to the running app

- Frontend change: `npm run build`, then ask the user to press ⌘R in the Worklog window. The server reads `web/dist` from disk on every request.
- Server or shared-model change: restart the server, but only if something listens on 4317 (otherwise the next double-click starts the new code):

  ```bash
  kill $(lsof -tiTCP:4317 -sTCP:LISTEN) 2>/dev/null
  mkdir -p logs
  nohup "$(sed -n 's/^WORKLOG_NODE=//p' ~/.config/worklog/env | tail -1)" server/main.ts >>logs/server.log 2>&1 </dev/null &
  ```

  The open window reconnects by itself and reloads the data. Do not use `scripts/start.sh` for this: right after a restart no window is connected yet, so it would open a second one.
- Launcher change: `npm run launcher` rebuilds `~/Desktop/Worklog.app`.

## Git

- `origin` is the public repository on GitHub. Work directly on `main`, no feature branches. Push only when the user asks.
- Commit messages: one short line in Russian, no `Co-Authored-By` or any other trailer, no AI mentions. They are public: the leak rule applies to them too.
- On the maintainer's machine `pre-commit` and `commit-msg` hooks run `scripts/check-leaks.sh`; never bypass them (`--no-verify`).
- `data/` is not part of this repository. Snapshots of it: `worklog data commit`.
