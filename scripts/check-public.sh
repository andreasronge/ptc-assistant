#!/usr/bin/env bash
# Refuses personal data in this public repository.
#   scripts/check-public.sh            # check staged files (pre-commit)
#   scripts/check-public.sh --all      # check every tracked file (CI)
set -euo pipefail

if [[ "${1:-}" == "--all" ]]; then
  files=$(git ls-files)
else
  files=$(git diff --cached --name-only --diff-filter=ACMR)
fi
[[ -z "$files" ]] && exit 0

status=0

# 1. Paths that only ever hold personal data.
personal='(^|/)(state|traces|reports|inspection)/|(^|/)rules/mail\.edn$|\.ptcins$|\.jsonl$|(^|/)\.env|client_secret.*\.json$|token.*\.json$'
if bad=$(printf '%s\n' "$files" | grep -E "$personal"); then
  echo "personal-data path must not be committed:" >&2
  printf '  %s\n' $bad >&2
  status=1
fi

# 2. Email addresses outside reserved example domains (RFC 2606) and
#    addresses that are part of public documentation of third parties.
allowed='@(([a-z0-9.-]+\.)?example\.(com|org|net)|[a-z0-9.-]+\.example|anthropic\.com|typesafe\.ai|users\.noreply\.github\.com)$'
while IFS= read -r file; do
  [[ -f "$file" ]] || continue
  if [[ "${1:-}" == "--all" ]]; then
    content=$(cat -- "$file")
  else
    content=$(git show ":$file")
  fi
  hits=$(printf '%s' "$content" | grep -oEi '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' | grep -viE "$allowed" | sort -u || true)
  if [[ -n "$hits" ]]; then
    echo "$file: email address outside example domains:" >&2
    printf '  %s\n' $hits >&2
    status=1
  fi
done <<< "$files"

exit $status
