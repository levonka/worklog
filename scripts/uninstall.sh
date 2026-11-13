#!/bin/zsh
# removes what the install put outside the clone and what points at this clone: the running server, skill and CLI links, the Desktop launcher, Warp tab files; settings, secrets, data and the clone stay for the agent to ask about
set -eu

root=${0:A:h:h}
source "$root/scripts/settings.sh"

# the server of this clone: started by start.sh with the full path or from the clone with a relative one
worklog_setting WORKLOG_PORT
for pid in ${(f)"$(lsof -tiTCP:${REPLY:-4317} -sTCP:LISTEN 2>/dev/null || true)"}; do
  command=$(ps -o command= -p "$pid" 2>/dev/null || true)
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
  if [[ $command == *" $root/server/main.ts" || ( $command == *" server/main.ts" && $cwd == "$root" ) ]]; then
    kill "$pid" && print "Сервер Worklog остановлен"
  fi
done

# $1 is a link into this clone
unlink_ours() {
  if [[ -L $1 && $(readlink "$1") == "$root"/* ]]; then
    rm "$1"
    print "Убрано: $1"
  fi
}

for dir in "${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}" "${CODEX_SKILLS_DIR:-$HOME/.agents/skills}"; do
  for link in "$dir"/*(N@); do unlink_ours "$link"; done
done
unlink_ours "${WORKLOG_BIN_DIR:-$HOME/.local/bin}/worklog"

app=$HOME/Desktop/Worklog.app
# the launcher runs this clone's start.sh, quoted the way build-launcher.sh quotes it
script=$root/scripts/start.sh
script=${script//\\/\\\\}
script=${script//\"/\\\"}
if [[ -d $app ]] && osadecompile "$app/Contents/Resources/Scripts/main.scpt" 2>/dev/null | grep -qF "\"$script\""; then
  rm -rf "$app"
  print "Убрано: $app"
fi

for file in "$HOME"/.warp/tab_configs/worklog-run-*.toml(N); do
  rm "$file"
  print "Убрано: $file"
done
