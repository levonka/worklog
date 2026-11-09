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

for target in $targets; do
  mkdir -p "$target"
  for dir in "$root"/skills/*(/); do
    name=${dir:t}
    link="$target/$name"
    if [[ -L $link && $(readlink "$link") == "$dir" ]]; then
      print "$name: уже установлен в $target"
    elif [[ -e $link || -L $link ]]; then
      print -u2 "$name: пропускаю, в $target уже есть $name не из Worklog"
      failed=1
    else
      ln -s "$dir" "$link"
      print "$name → $link"
    fi
  done
done

bin_dir=${WORKLOG_BIN_DIR:-$HOME/.local/bin}
mkdir -p "$bin_dir"
cli="$bin_dir/worklog"
if [[ -L $cli && $(readlink "$cli") == "$root/bin/worklog" ]]; then
  print "worklog: уже установлен"
elif [[ -e $cli || -L $cli ]]; then
  print -u2 "worklog: пропускаю, в $bin_dir уже есть worklog не из этой папки"
  failed=1
else
  ln -s "$root/bin/worklog" "$cli"
  print "worklog → $cli"
fi

exit $failed
