#!/bin/zsh
# Worklog on invented data for screenshots and manual checks: a fresh temporary folder, its own port, no Jira, no sessions or settings of this machine
set -eu

root=${0:A:h:h}
source "$root/scripts/settings.sh"
dir=$(mktemp -d -t worklog-demo)
mkdir -p "$dir/sessions"
export WORKLOG_DATA_DIR=$dir/data WORKLOG_PROFILE=$dir/profile.json WORKLOG_ENV_FILE=/nonexistent WORKLOG_JIRA=off WORKLOG_JIRA_P12=/nonexistent
export WORKLOG_CLAUDE_PROJECTS_DIR=$dir/sessions WORKLOG_CODEX_SESSIONS_DIR=$dir/sessions WORKLOG_PORT=${WORKLOG_PORT:-4399}
"$NODE" "$root/scripts/demo-data.ts" "$WORKLOG_DATA_DIR" "$WORKLOG_PROFILE"
print "Демо: http://127.0.0.1:$WORKLOG_PORT — данные в $dir, выход — Ctrl+C"
exec "$NODE" "$root/server/main.ts"
