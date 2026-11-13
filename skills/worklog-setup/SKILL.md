---
name: worklog-setup
description: Use when the user asks to install, finish installing, update, re-check, repair or remove Worklog, or to update its company profile — «обнови worklog», «обнови профиль worklog», «продолжи установку worklog», «worklog не работает», «проверь worklog», «удали worklog».
---

# Worklog: install, update, repair

1. Find the clone: `readlink ~/.local/bin/worklog` gives `<clone>/bin/worklog`. No link — ask the user where Worklog lies.
2. Read `<clone>/INSTALL.md` — its «Rules» first, then the section for the request:
   - «продолжи установку worklog», «установи worklog» — «Install», from the first step whose `doctor` checks do not pass;
   - «обнови worklog» — «Update Worklog»;
   - «обнови профиль worklog» — «Update the profile»;
   - «worklog не работает», «проверь worklog» — «Worklog does not work»;
   - «удали worklog» — «Uninstall».
3. Do what the section says. Run the CLI as `~/.local/bin/worklog <command>`, one command per call. Talk to the user in Russian.
