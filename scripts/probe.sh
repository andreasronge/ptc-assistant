#!/usr/bin/env bash
# Phase 0 probe: today's events and 50 inbox message headers through ptc and
# google-mcp, from the deployed app (scripts/deploy.sh). Writes only under
# $PTC_ASSISTANT_DATA; prints only counts.
#
#   PTC_ASSISTANT_DATA=... GOOGLE_MCP_CLIENT_FILE=... GOOGLE_MCP_TOKEN_FILE=... scripts/probe.sh
#
# PROBE_HOST=fake runs it against the fake Google in google-mcp/test/helpers
# (no credentials needed). PROBE_CALENDAR_IDS='["primary","<id>"]' and
# PROBE_DAYS=N widen the calendar check.
source "$(dirname "$0")/lib.sh"

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

project="$data/probe.ptc-project.json"
[[ -f "$project" ]] || {
  echo "probe: $project is missing; run scripts/deploy.sh" >&2
  exit 1
}
if [[ "${PROBE_HOST:-}" == "fake" ]]; then
  fake_project="$data/.probe-fake.ptc-project.json"
  jq '.host.path = "app/workflows/ptc-host.fake.json"' "$project" >"$fake_project"
  project=$fake_project
fi

with_lock
run_id=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$data/probe"
input="$data/probe/input-$run_id.json"
output="$data/probe/result-$run_id.json"

jq -n --arg min "$(day_start 0)" --arg max "$(day_start "${PROBE_DAYS:-1}")" \
  --argjson calendars "${PROBE_CALENDAR_IDS:-null}" \
  '{query: "in:inbox", limit: 50, time_min: $min, time_max: $max}
   + (if $calendars then {calendar_ids: $calendars} else {} end)' >"$input"

cd "$data"
"$ptc" run "$(basename "$project")" --private-input "$input" --private-output "$output" >/dev/null

# Counts only: the result holds mail metadata and stays in the private file.
jq -r '"events: \(.event_count), message headers: \(.message_count)"' "$output"
echo "result: $output"
