#!/bin/zsh
set -eu

ROOT=${0:A:h:h}
APP=$HOME/Desktop/Worklog.app

if [[ -e $APP || -L $APP ]]; then
  # ours is an applet that runs some clone's scripts/start.sh
  if ! osadecompile "$APP/Contents/Resources/Scripts/main.scpt" 2>/dev/null | grep -q '/scripts/start\.sh"$'; then
    print -u2 "$APP уже есть и это не ярлык Worklog: не трогаю. Убери или переименуй его и запусти снова"
    exit 1
  fi
  rm -rf "$APP"
fi
# ROOT goes inside an AppleScript string literal
SCRIPT=$ROOT/scripts/start.sh
SCRIPT=${SCRIPT//\\/\\\\}
SCRIPT=${SCRIPT//\"/\\\"}
osacompile -o "$APP" -e "do shell script quoted form of \"$SCRIPT\""
echo "Создано $APP"
