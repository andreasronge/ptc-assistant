# shellcheck shell=bash
# Shared by the box scripts. Source it; it sets repo, data, and ptc.
set -euo pipefail

# shellcheck disable=SC2034 # repo, data, and ptc are for the sourcing script
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
data=${PTC_ASSISTANT_DATA:?PTC_ASSISTANT_DATA must name the private data directory}
# The pinned build from scripts/build-ptc.sh; PTC_BIN overrides it for development.
ptc=${PTC_BIN:-$repo/releases/current/bin/ptc}
export TZ=Europe/Stockholm
# Cron and non-interactive SSH have no locale; Erlang then falls back to latin1.
export LC_ALL=C.UTF-8
umask 077

[[ -x "$ptc" ]] || {
  echo "no ptc at $ptc: run scripts/build-ptc.sh or set PTC_BIN" >&2
  exit 1
}

# RFC 3339 midnight N days from today, with the offset in force at that midnight.
day_start() {
  local day stamp
  if date -d today >/dev/null 2>&1; then
    day=$(date -d "today +$1 day" +%Y-%m-%d)
    stamp=$(date -d "$day 00:00" +%Y-%m-%dT00:00:00%z)
  else
    day=$(date -v+"$1"d +%Y-%m-%d)
    stamp=$(date -j -f '%Y-%m-%d %H:%M' "$day 00:00" +%Y-%m-%dT00:00:00%z)
  fi
  printf '%s:%s' "${stamp:0:22}" "${stamp:22:2}"
}

# Writes stdin to $1 through a temporary sibling, so readers never see half a file.
write_atomic() {
  cat >"$1.tmp.$$"
  mv -f "$1.tmp.$$" "$1"
}

# One lock for everything that runs workflows or replaces the deployed app, so
# runs never overlap and a deploy never swaps the app under a running workflow.
# flock is on the Ubuntu box; a development Mac without it runs unlocked.
with_lock() {
  # A script called by run-daily.sh already runs under the lock.
  [[ "${PTC_ASSISTANT_LOCKED:-}" == 1 ]] && return 0
  if command -v flock >/dev/null; then
    exec 9>"$data/run.lock"
    flock -w 3600 9 || {
      echo "timed out waiting for $data/run.lock" >&2
      exit 1
    }
  fi
  export PTC_ASSISTANT_LOCKED=1
}
