---
name: worklog-notes
description: Use when the user asks to save knowledge to Worklog's knowledge base («запиши в базу», «запомни в знаниях», «добавь заметку»), asks what the base knows («что есть в базе по капче»), or when starting work on a task tracked in Worklog (a ticket key, a branch feature/<KEY>, a direction named by the user) — read its notes before touching the code.
---

# Worklog: knowledge notes

The knowledge base lives in Worklog: short notes with links to code files (they open in the editor on the line) and to pages. Run the CLI exactly as `~/.local/bin/worklog <command>`, one command per Bash call, no `cd`, so one permission rule can cover every call. Never edit files under Worklog's `data/` by hand.

## Before working on a task

1. `dir show <KEY or title part>` — the direction, its links (with descriptions) and the list of its notes.
2. `note show <id>` for each note that looks relevant, or `note list --search "<words>"` across the whole base.
3. Take the notes as hints from the past, not as truth: check them against the code. If a note turned out wrong or outdated, tell the user and offer to fix it with `note edit`.

## Writing a note («запиши в базу»)

- **Short**: a title and 3–10 lines. One fact or one decision per note.
- **No duplicates**: if the fact is already in a README, the code or Confluence, the note is one line plus a link to it. Search first (`note list --search …`) and edit the existing note instead of adding a second one.
- **Links**: code paths relative to the project folder's root (`WORKLOG_CODE_ROOT`), with a line when it matters: `--link libs/<lib>/README.md`, `--link libs/<lib>/<file>.ts:42`; pages as `--link "https://… название"`. Check that every file exists (Read or ls) before linking it. Prefer the README next to the code over a copy of it in a note.
- **Attach** to the direction(s) it is about: `--dir <KEY or title part>` (repeat for several).
- Show the user the note (title, text, links, direction) and write it only after they confirm — unless they dictated it word for word.

Example (paths are placeholders):

```
note add "Общие ключи в localStorage" --body "Сайт и админка делят ключи app.* в localStorage.
Переименовать ключ в одном приложении нельзя — сломается другое." --dir APP-9508 --link libs/<lib>/README.md --link libs/<lib>/<file>.ts:42
```

## Other commands

- `note list [--dir REF] [--search Q]` — newest first; «битых ссылок: N» means files that are gone.
- `note edit <note> [--title] [--body] [--dir REF]... [--link L]... [--no-dirs] [--no-links]` — given `--dir`/`--link` replace the whole list, so pass every link that should stay (`note show` lists them).
- `note rm <note>`, `note check` (every broken file link). `<note>` is an id or a part of the title only one note has.

Notes are for the user and for the coding agent, they never go into the daily; still write them plainly, without mentioning AI.
