---
name: worklog-update
description: Use when the user asks to record something in Worklog, their personal tracker of work directions — an event in a direction («по сео: Олег подтвердил баг бэка»), a link or ticket («добавь в капчу ссылку на BRD»), a new direction («заведи направление»), a status change («сео на тестировании», «жду девопсов по редиректу»), a todo or a colleague's request («аналитик попросил завести задачу на бэк»), a sidebar link, a description of a link («к КЭДО допиши, что там подписываю отпуска»), or «подготовь дейлик». Knowledge notes («запиши в базу») are the `worklog-notes` skill.
---

# Worklog: record by phrase

Worklog's folder is where `~/.local/bin/worklog` points (`readlink ~/.local/bin/worklog`); its data is the user's real work log. Write only through the CLI.

## CLI

- Always run it as `~/.local/bin/worklog <command>`: this exact path, one command per Bash call, no `cd`, no `&&` chains, so one permission rule (`Bash(~/.local/bin/worklog:*)` in Claude Code) can cover every call.
- `~/.local/bin/worklog` with no arguments prints every command and status alias. Works whether the app is open or not; an open window updates by itself.
- Never edit files under Worklog's `data/` by hand. Changing the app's code is a different job: read `CLAUDE.md` (`AGENTS.md`) in Worklog's folder first.

## Steps

1. Run `state` once per conversation (again after the user says they changed things in the app) to see directions, statuses and open todos with their ids.
2. Pick the direction. `<ref>` is a direction id, a ticket key, or part of the title («сео», «капч»). If the CLI says several match, use the id from `state`. If you cannot tell which direction the user means, ask one short question.
3. Run the commands. One phrase often means several: «жду девопсов, завёл им INFRA-4601» = `ticket add`, `dir status … wait --waiting девопсы` and an `event`.
4. Report in one line what was written. Do not ask for confirmation when the request is clear — recording must take no longer than saying the phrase.

## Phrase → command

| User says | Command |
|---|---|
| what happened in a direction | `event <ref> "<text>"` |
| a task number belongs to a direction | `ticket add <ref> <KEY>` |
| a link (BRD, Figma, MR, Swagger, Jenkins…) | `link add <ref> <url> --title "<short title>"` — the kind is detected from the URL |
| a new direction | `dir add "<title>" --ticket <KEY>... [--status S] [--waiting WHO]` |
| жду / отложено | `dir status <ref> wait\|parked [--waiting WHO]` |
| больше не жду, вернуть из отложенных | `dir unmark <ref>` |
| stage: в работе / в мерж реквесте / тестирование / ждёт релиза / готово | `dir status <ref> work\|mr\|test\|release\|done` — only for a direction whose `dir show` says `Этап: … (вручную)` |
| when a done direction was done: «промокоды сделал 9 апреля» | `dir done-at <ref> YYYY-MM-DD` — the app stamps the date itself when a direction becomes done |
| a todo, a colleague's request that can't be done right away | `todo add "<what to do>" [--dir <ref>] [--from <name in genitive: Олега>] [--due YYYY-MM-DD] [--time HH:MM] [--link <url>]` |
| a link or time for an existing todo or repeating todo: «к делу "проверить почту" добавь ссылку на почту» | `todo edit <id>` or `repeat edit <id>` (ids from `todo list` / `repeat list`) with `--link <url>` / `--no-link`, `--time HH:MM` / `--no-time`; for a todo made by a rule edit the rule — its open todo follows |
| a todo is done | `todo done <id>` (id from `state` or `todo list`) |
| a repeating todo: «каждый день проверять почту», «по понедельникам встреча» | `repeat add "<what to do>" --every day\|weekdays\|mon,…,sun [--dir <ref>] [--from <name>] [--time HH:MM] [--link <url>]` — today's todo appears at once if today is one of its days; `repeat list`, `repeat rm <id>` to stop it |
| a permanent link for the sidebar | `quicklink add "<group>" "<title>" <url> [--desc "<text>"]` — groups: Каждый день, Разработка, Дизайн и доки, Корпоративное |
| what a link is, how to log in, anything useful about it | direction link: `link desc <ref> <url> "<text>"`; sidebar link: `quicklink desc "<group>" <url> "<text>"`; `""` removes it. `link add … --desc` sets it at once |
| the agent's work in this session is finished (the starting prompt names the run id) | `agent done <id>`; `agent list` shows the running ones |
| «подготовь дейлик» | see below |

- A status change and a finished todo write their own event: do not add a second event that says the same.
- The stage of a direction with tickets in the company profile's projects comes from Jira (`dir show` says `Этап: … (Jira)`). When the user names a stage for it («сео на тестировании»), change nothing and answer in one line: «этап берётся из Jira, сейчас: <этап>». «Жду» and «Отложено» work for every direction.
- A link description replaces the old one: to add a line, read the current text first (`dir show <ref>` or `state --json`) and send the whole new text. It is for the user only, not the daily: write it as a short reference («Кадровый ЭДО: отпуска, справки, подпись документов. Вход — корпоративный логин»), never put passwords in it.
- Do not invent facts, names or numbers the user did not give; take URLs and keys only from the user or the open conversation.

## Event texts

Events go into the daily report the user reads to their manager. Hard rules:
- First person singular, past or present tense, as the user would say it: «Пообщался с Олегом Петровым: это баг бэка, договорились завести задачу на фикс», «Создал задачу девопсам через их дашборд (INFRA-4601), жду реакции».
- Never mention AI, Claude, an agent, a session or generation — the work is the user's own.
- One or two short sentences, no Markdown. Keep the user's own wording when it is already fine; add ticket keys when they matter.
- Text that starts with `-` goes after `--`: `event <ref> -- "-5 багов"`.

## «Подготовь дейлик»

1. Run `daily show`: the period, the current daily text (the app's draft — the template from events, or the session summary if the user built it) and whom the user is waiting for.
2. If this conversation contains work that is not in the text, offer to record it as events first; after recording, run `daily show` again. If the user already edited the text in the app, it is not rebuilt: say that the app shows «появились новые события — пересобрать?».
3. Show the text as it is. For a fuller version from all sessions, the user presses «✦ Собрать из сессий» on the Дейлик screen. Editing the text and «Дейлик прошёл» happen in the app.
