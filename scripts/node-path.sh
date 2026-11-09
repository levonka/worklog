# sourced by bin/worklog and scripts/start.sh: NODE is WORKLOG_NODE, else its line in the env file, else node from PATH
# the file is read the way server/env-file.ts reads it: the last line wins, no \r, one pair of quotes, ~/ is home
NODE=${WORKLOG_NODE:-}
if [[ -z $NODE ]]; then
  env_file=${WORKLOG_ENV_FILE:-$HOME/.config/worklog/env}
  if [[ -r $env_file ]]; then
    for line in "${(@f)$(<$env_file)}"; do
      if [[ $line == WORKLOG_NODE=* ]]; then NODE=${line#WORKLOG_NODE=}; fi
    done
  fi
fi
NODE=${NODE%$'\r'}
if [[ $NODE == \"*\" || $NODE == \'*\' ]]; then NODE=${${NODE#?}%?}; fi
NODE=${NODE/#\~\//$HOME/}
NODE=${NODE:-$(command -v node || true)}
