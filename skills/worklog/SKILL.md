---
name: worklog
description: Use when the user runs /worklog (Claude Code) or $worklog (Codex) at the end of a session to carry the session's results into Worklog, their personal tracker of work directions.
disable-model-invocation: true
argument-hint: "[что учесть]"
---

# Worklog: end of session

Look back over this conversation and propose what to record in Worklog: events in direction feeds, todos, status changes, knowledge notes. Nothing is written before the user confirms the list.

Run the CLI exactly as `~/.local/bin/worklog <command>`, one command per Bash call, no `cd`. Never edit files under Worklog's `data/` by hand. Command syntax and event-text rules are in the `worklog-update` skill, note rules in `worklog-notes`; follow both.

## Steps

1. **Collect the session's results** from the conversation (after a compaction — from its summary). If the work was in a git repository, `git log --oneline` of the commits made in this session fills gaps. Text after `/worklog` is extra facts or a focus from the user: take it as given.
2. **Map to directions**: run `state`, then `dir show <ref>` for each direction the session touched — by ticket key in the conversation or in the branch name (`feature/APP-9355_WEB-5586`), or by topic. Its recent events and todos show what is already recorded: drop anything already there, including what was recorded earlier in this session. If `/worklog` already ran in this conversation, start after that point.
3. **Show one numbered list**, grouped by direction, each item the text that will be written:

   ```
   SEO-текст на страницах матчей
   1. событие: «Вывел новый баннер на главную, MR !3901»
   2. жду: Олега (ревью)
   3. дело: «Завести задачу бэку на суффикс в SEO-админке» (от Олега)
   Без направления
   4. новое направление «Лимиты ставок» (APP-9700), статус В работе
   В базу знаний
   5. заметка «Лимиты: считаются на бэке» → APP-9700, ссылки: libs/…/README.md
   ```

   End with: «Записать всё? Можно номера: убрать или поправить».
4. **Write after the answer**, only the confirmed items, then report in one line what was written. Nothing confirmed — write nothing.

## What goes into the list

| Session result | Item |
|---|---|
| work done: a fix, a feature, an MR, an analysis, a finding, a conversation outcome | event — one or two per direction, at the level of the daily report, not per file or step |
| a colleague's request or an agreed follow-up not done in the session | `todo add` with `--dir` and `--from` |
| an open todo the session finished (ids from `dir show` / `todo list`) | `todo done <id>` — it writes its own event, do not add a second one |
| waiting for someone, parked, or no longer waiting | `dir status … wait --waiting WHO` / `parked`, `dir unmark` |
| a stage change the conversation shows (MR handed to testing, released) — only for a direction whose `dir show` says `Этап: … (вручную)`; a `(Jira)` stage moves by itself | `dir status` |
| a ticket key, MR or page link a direction lacks | `ticket add` / `link add` |
| work with a ticket but no direction | new direction (`dir add`), ask its status if unclear |
| a non-obvious fact or decision worth keeping (why the code is as it is, a trap, an agreement) | knowledge note per `worklog-notes` |
| the session was started from Worklog (`$WORKLOG_RUN_ID` is set or the starting prompt names a run id) | `agent done <id>` as the last item |

Not on the list: reading code, failed attempts that left nothing, routine commands, work on Worklog itself or other personal tooling, anything the user said to keep out. A session with nothing worth recording: say so in one line and stop.

## Rules

- Events go into the daily the user reads to their manager: first person singular, the user's own work, no mention of AI, Claude, an agent or a session; ticket keys and MR numbers only from the conversation.
- Never invent results, names or statuses. If it is unclear whether something got done (an MR merged, a colleague answered), ask in the list instead of guessing: «7. MR !3901 влит? — если да, статус → Ждёт релиза» (for a direction whose stage is not from Jira).
