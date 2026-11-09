---
name: worklog-chrome-tabs
description: Use when the user asks to sort their open Chrome tabs into Worklog — «разбери вкладки», «разложи вкладки по направлениям», «что из вкладок сохранить в worklog».
---

# Worklog: sort open Chrome tabs

Turns the user's open Chrome tabs into links and tickets of Worklog directions, so the tabs can be closed without losing context. The user closes tabs themselves: never close, reload or open tabs.

Run the CLI exactly as `~/.local/bin/worklog <command>`, one command per Bash call, no `cd`, so one permission rule can cover every call. Never edit files under Worklog's `data/` by hand. For the recording rules and event texts see the `worklog-update` skill.

## Steps

1. Run `state`, then `tabs`. `tabs` reads the newest session file of the last used Chrome profile and prints the open tabs in three groups:
   - under a direction — the tab mentions one of its tickets or is already one of its links;
   - «Номера без направления» — task keys no direction has;
   - «Без номеров».
   `· сохранена` after a URL means it is already a link or ticket in Worklog (or a sidebar link): nothing to do. `tabs --json` gives the same with keys and direction ids.
2. Build one numbered proposal, grouped by direction:
   - **links to add**: work pages not saved yet — Confluence (BRD, UI, тех. анализ), Figma, MR, branch, Jenkins, Swagger, docs. Short Russian title, the way the user names things: «BRD», «Figma: CAPTCHA», «MR !3852», «Jenkins: сборка». A tab under a direction that is only the Jira page of its own ticket needs nothing.
   - **tickets to add**: a tab clearly about a direction mentions another key (parent, related backend task).
   - **tabs without keys**: match them to a direction by title and content words («Капча — теханализ» → Капча). Permanent tools that are not a sidebar link yet (dashboards, stands) → offer as sidebar links. Unclear work tabs → list under «не понял, куда» with the title.
   - **«Номера без направления»**: per key, offer «новое направление», «к направлению …» or «пропустить». A login page («Вход», «Log in») hides the title: show the key and say you cannot see what the task is.
   - Personal tabs (YouTube, music, shops, news) and generic pages (Jira board, mail, search) — do not list them, give only their count.
3. Ask the user to confirm: «всё», or numbers to drop or change. Do not write anything before the answer.
4. Apply the confirmed items with `link add`, `ticket add`, `dir add`, `quicklink add`. For a new direction without tickets in the profile's projects ask its status if the user did not say it; one with tickets in the profile's projects takes its stage from Jira.
5. Finish with the list of tabs that are now fully in Worklog — the user can close them — and the ones left unsorted.

## Rules

- Never invent: titles come from the tab, URLs are copied as they are (only cut tracking parameters like `utm_*`).
- One tab may belong to two directions (a shared BRD): ask, do not guess.
- If `tabs` fails (Chrome not installed, no session file), show its error and stop.
