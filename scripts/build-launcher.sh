#!/bin/zsh
set -eu

ROOT=${0:A:h:h}
APP=$HOME/Desktop/Worklog.app

rm -rf "$APP"
# ROOT goes inside an AppleScript string literal
SCRIPT=$ROOT/scripts/start.sh
SCRIPT=${SCRIPT//\\/\\\\}
SCRIPT=${SCRIPT//\"/\\\"}
osacompile -o "$APP" -e "do shell script quoted form of \"$SCRIPT\""
echo "Создано $APP"
