# Shared by the box scripts. Source it; it sets repo, data, and ptc.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
data=${PTC_ASSISTANT_DATA:?PTC_ASSISTANT_DATA must name the private data directory}
# The pinned build from scripts/build-ptc.sh; PTC_BIN overrides it for development.
ptc=${PTC_BIN:-$repo/releases/current/bin/ptc}
export TZ=Europe/Stockholm
umask 077

[[ -x "$ptc" ]] || {
  echo "no ptc at $ptc: run scripts/build-ptc.sh or set PTC_BIN" >&2
  exit 1
}

# One lock for everything that runs workflows or replaces the deployed app, so
# runs never overlap and a deploy never swaps the app under a running workflow.
# flock is on the Ubuntu box; a development Mac without it runs unlocked.
with_lock() {
  if command -v flock >/dev/null; then
    exec 9>"$data/run.lock"
    flock -w 3600 9 || {
      echo "timed out waiting for $data/run.lock" >&2
      exit 1
    }
  fi
}
