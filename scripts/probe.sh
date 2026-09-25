#!/usr/bin/env bash
# Phase 0 probe: today's events and 50 inbox message headers through ptc and
# google-mcp. Everything it writes goes under $PTC_ASSISTANT_DATA.
#
#   PTC_ASSISTANT_DATA=... GOOGLE_MCP_CLIENT_FILE=... GOOGLE_MCP_TOKEN_FILE=... scripts/probe.sh
#
# Set PTC_HOST_CONFIG=workflows/ptc-host.fake.json to run against the fake
# Google in google-mcp/test/helpers instead (no credentials needed).
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
data=${PTC_ASSISTANT_DATA:?PTC_ASSISTANT_DATA must name the private data directory}
host_config=${PTC_HOST_CONFIG:-$repo/workflows/ptc-host.json}
export TZ=Europe/Stockholm

# RFC 3339 with a colon in the offset, from GNU or BSD date.
day_start() { # $1: 0 for today, 1 for tomorrow
  local stamp
  if date -d today >/dev/null 2>&1; then
    stamp=$(date -d "today +$1 day" +%Y-%m-%dT00:00:00%z)
  else
    stamp=$(date -v+"$1"d +%Y-%m-%dT00:00:00%z)
  fi
  # The offset is today's; recompute it at midnight so a DST change is honoured.
  if date -d today >/dev/null 2>&1; then
    stamp=$(date -d "${stamp:0:10} 00:00" +%Y-%m-%dT00:00:00%z)
  else
    stamp=$(date -j -f '%Y-%m-%d %H:%M' "${stamp:0:10} 00:00" +%Y-%m-%dT00:00:00%z)
  fi
  printf '%s:%s' "${stamp:0:22}" "${stamp:22:2}"
}

umask 077
run_id=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$data/probe" "$data/ptc/traces" "$data/ptc/inspection"
input="$data/probe/input-$run_id.json"
output="$data/probe/result-$run_id.json"

jq -n --arg min "$(day_start 0)" --arg max "$(day_start 1)" \
  '{query: "in:inbox", limit: 50, time_min: $min, time_max: $max}' >"$input"

ptc run "$repo/workflows/probe/ptc.json" \
  --host-config "$host_config" \
  --private-input "$input" \
  --private-output "$output" \
  --trace-dir "$data/ptc/traces" \
  --inspect "$data/ptc/inspection/probe-$run_id.ptcins"

# Counts only: the result holds mail metadata and stays in the private file.
jq -r '"events today: \(.event_count), message headers: \(.message_count)"' "$output"
echo "result: $output"
