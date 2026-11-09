#!/bin/zsh
# checks file names, staged contents and the author of this git repository, and optionally a commit message, against a private list of words that must never be published
set -u

list=${WORKLOG_DENYLIST:-$HOME/.config/worklog/denylist}
if [[ ! -f $list ]]; then
  print "Список запретных слов не найден ($list), проверка пропущена"
  exit 0
fi
patterns=$(mktemp)
trap 'rm -f "$patterns"' EXIT
grep -v -E '^[[:space:]]*(#|$)' "$list" > "$patterns"
if [[ ! -s $patterns ]]; then
  print "Список запретных слов пуст, проверка пропущена"
  exit 0
fi

found=0
report() {
  [[ -z $2 ]] && return
  print -r -- "$2" | sed "s/^/$1/"
  found=1
}

report 'имя файла: ' "$(git ls-files | grep -i -F -f "$patterns")"
# integrity hashes in lock files are base64 and hold any short word by chance
report '' "$(git grep --cached -n -I -i -F -f "$patterns" | grep -v -E '^[^:]+:[0-9]+:[[:space:]]*"integrity": "sha[0-9]+-[A-Za-z0-9+/=]+",?$')"
author=$(git var GIT_AUTHOR_IDENT 2>/dev/null | sed -E 's/ [0-9]+ [+-][0-9]{4}$//')
report 'автор: ' "$(print -r -- "$author" | grep -i -F -f "$patterns")"
if [[ ${1:-} == --message ]]; then
  report 'сообщение коммита: ' "$(grep -i -F -f "$patterns" "$2")"
fi

if (( found )); then
  print -u2 'Найдены запретные слова — в публичный репозиторий это не должно попасть'
  exit 1
fi
print 'Запретных слов нет'
