# sourced by bin/worklog, scripts/start.sh and scripts/install-skills.sh
# worklog_setting NAME sets REPLY: the environment variable, else its line in the env file, read the way server/env-file.ts reads it
# (the last line wins, no \r, one pair of quotes, ~/ is home); empty when neither has it
worklog_setting() {
  local env_file=${WORKLOG_ENV_FILE:-$HOME/.config/worklog/env} line
  REPLY=${(P)1:-}
  if [[ -z $REPLY && -r $env_file ]]; then
    for line in "${(@f)$(<$env_file)}"; do
      if [[ $line == $1=* ]]; then REPLY=${line#$1=}; fi
    done
  fi
  REPLY=${REPLY%$'\r'}
  if [[ $REPLY == \"*\" || $REPLY == \'*\' ]]; then REPLY=${${REPLY#?}%?}; fi
  REPLY=${REPLY/#\~\//$HOME/}
}

worklog_setting WORKLOG_NODE
NODE=${REPLY:-$(command -v node || true)}
