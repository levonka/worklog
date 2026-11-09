#!/bin/zsh
# links every skill folder in skills/ into the skills folder of each coding agent on this machine (Claude Code, Codex) and bin/worklog into ~/.local/bin, leaving foreign files alone
set -eu

root=${0:A:h:h}
failed=0
targets=()
[[ -n ${CLAUDE_SKILLS_DIR:-} || -d $HOME/.claude ]] && targets+=("${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}")
[[ -n ${CODEX_SKILLS_DIR:-} || -d $HOME/.codex ]] && targets+=("${CODEX_SKILLS_DIR:-$HOME/.agents/skills}")
if (( ${#targets} == 0 )); then
  print -u2 'Не найдены ни Claude Code (~/.claude), ни Codex (~/.codex): скиллы ставить некуда'
  failed=1
fi

# links $1 at $2 unless something that is not ours already sits there
link_to() {
  local src=$1 link=$2
  if [[ -L $link && $(readlink "$link") == "$src" ]]; then
    print "${link:t}: уже установлен в ${link:h}"
  elif [[ -e $link || -L $link ]]; then
    print -u2 "${link:t}: пропускаю, в ${link:h} уже есть ${link:t} не из Worklog"
    failed=1
  else
    ln -s "$src" "$link"
    print "${link:t} → $link"
  fi
}

for target in $targets; do
  mkdir -p "$target"
  for dir in "$root"/skills/*(/); do
    link_to "$dir" "$target/${dir:t}"
  done
done

bin_dir=${WORKLOG_BIN_DIR:-$HOME/.local/bin}
mkdir -p "$bin_dir"
link_to "$root/bin/worklog" "$bin_dir/worklog"

exit $failed
