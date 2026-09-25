#!/usr/bin/env bash
# Enforces the rolling trace window (SPEC.md, "Traces"): 30 days and 5 GB,
# whichever is hit first. Runs with a keep/<run_ref> marker are exempt.
#
#   scripts/prune.sh            # delete
#   scripts/prune.sh --dry-run  # preview
source "$(dirname "$0")/lib.sh"

max_age_days=${PTC_PRUNE_MAX_AGE_DAYS:-30}
max_bytes=${PTC_PRUNE_MAX_BYTES:-5000000000}

# All deployed project files share the artifact root, so any one of them names it.
project=$(find "$data" -maxdepth 1 -name '*.ptc-project.json' -print -quit)
[[ -n "$project" ]] || {
  echo "prune: no project file in $data; run scripts/deploy.sh" >&2
  exit 1
}
[[ -d "$data/ptc" ]] || exit 0
mkdir -p -m 700 "$data/ptc/keep"

with_lock
cd "$data"
"$ptc" prune "$(basename "$project")" --max-age-days "$max_age_days" --max-bytes "$max_bytes" "$@"
