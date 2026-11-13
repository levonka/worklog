#!/bin/zsh
set -eu

ROOT=${0:A:h:h}
source "$ROOT/scripts/settings.sh"
worklog_setting WORKLOG_PORT
PORT=${REPLY:-4317}
APP_URL=http://localhost:$PORT
HEALTH_URL=$APP_URL/api/health
LOG=$ROOT/logs/server.log

is_up() {
  curl -fsS "$HEALTH_URL" >/dev/null 2>&1
}

# the title and the message go as arguments: no quoting for AppleScript
alert() {
  osascript - "$1" "$2" >/dev/null 2>&1 <<'APPLESCRIPT' || true
on run argv
  display alert (item 1 of argv) message (item 2 of argv)
end run
APPLESCRIPT
}

# what the server printed after the log had $1 bytes: its error line, else its last line, up to 200 characters
start_failure() {
  local LC_ALL=en_US.UTF-8 reason
  reason=$(tail -c +$(($1 + 1)) "$LOG" 2>/dev/null | awk '
    /^[A-Za-z]*Error[^:]*: / { error = $0 }
    NF && !/^Node\.js v/ { last = $0 }
    END { print (error != "" ? error : last) }')
  REPLY=${reason[1,200]}
}

# brings Chrome's first window showing Worklog to the front; prints found or none
raise_window() {
  osascript - "$APP_URL" <<'APPLESCRIPT'
on run argv
  if application "Google Chrome" is not running then return "none"
  set appUrl to (item 1 of argv) & "/"
  tell application "Google Chrome"
    repeat with candidate in windows
      if (URL of active tab of candidate) starts with appUrl then
        set index of candidate to 1
        activate
        return "found"
      end if
    end repeat
  end tell
  return "none"
end run
APPLESCRIPT
}

if [[ -z $NODE ]]; then
  alert "Worklog не запустился" "Не найден node — укажи WORKLOG_NODE в ~/.config/worklog/env"
  exit 1
fi

if [[ ! -f $ROOT/web/dist/web/browser/index.html ]]; then
  PATH=${NODE:h}:$PATH npm --prefix "$ROOT" run build
fi

if ! is_up; then
  mkdir -p "$ROOT/logs"
  log_size=$(stat -f %z "$LOG" 2>/dev/null || echo 0)
  # the app starts with a bare PATH: the server's tools (claude, the editor) may be scripts that need node
  PATH=${NODE:h}:$PATH nohup "$NODE" "$ROOT/server/main.ts" >>"$LOG" 2>&1 </dev/null &
  for _ in {1..50}; do
    is_up && break
    sleep 0.1
  done
  if ! is_up; then
    start_failure $log_size
    alert "Worklog не запустился" "${REPLY:+$REPLY

}Подробности: logs/server.log"
    exit 1
  fi
fi

# every open window holds a live connection; a second window would stack on top of the first.
# AppleScript may reach another Chrome instance (spec §5.2), so not finding the window still opens one
health=$(curl -fsS "$HEALTH_URL" 2>/dev/null || true)
if [[ $health =~ '"clients":([0-9]+)' ]] && (( match[1] > 0 )) && [[ $(raise_window 2>/dev/null) == found ]]; then
  exit 0
fi

open -na "Google Chrome" --args --app=$APP_URL
