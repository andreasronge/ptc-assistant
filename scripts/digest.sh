#!/usr/bin/env bash
# Runs the daily digest (rules layer) from the deployed app and stores its
# result under $PTC_ASSISTANT_DATA/digest/. Exit 3 means "reconnect Google".
#
#   digest/<date>.json             the digest the page is rendered from
#   digest/predictions/<run>.json  one prediction per message, for the oracle
#   digest/state.json              cursor, sent-mail sync point, last message ids
#   digest/correspondents.json     addresses the owner has written to
#   www/<date>.html, www/index.html
#
# DIGEST_HOST=fake runs against the fake Google (no credentials needed).
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

rules="$data/rules/mail.json"
dir="$data/digest"
project="$data/digest.ptc-project.json"
[[ -f "$rules" ]] || { echo "digest: $rules is missing" >&2; exit 1; }
[[ -f "$project" ]] || { echo "digest: $project is missing; run scripts/deploy.sh" >&2; exit 1; }
if [[ "${DIGEST_HOST:-}" == "fake" ]]; then
  jq '.host.path = "app/workflows/ptc-host.fake.json"' "$project" >"$data/.digest-fake.ptc-project.json"
  project="$data/.digest-fake.ptc-project.json"
else
  status=0
  node "$data/app/google-mcp/dist/cli.js" check 2>/dev/null || status=$?
  if ((status != 0)); then
    echo "digest: google-mcp check failed (exit $status)" >&2
    exit "$status"
  fi
fi

with_lock
mkdir -p "$dir/predictions" "$dir/runs" "$data/www"
now=$(date +%s)
run_id=$(date -u +%Y%m%dT%H%M%SZ)
day=86400

# Mail window: from the last successful run on an earlier day minus one hour of
# overlap (dupes are removed by message id), at most 7 days back, 24 hours on
# the first run. A rerun on the same day starts from where that day's first
# run started, so it rebuilds the whole day's digest instead of an empty one.
state="$dir/state.json"
[[ -f "$state" ]] || echo '{}' >"$state"
today=$(day_start 0 | cut -c1-10)
if [[ "$(jq -r '.day // empty' "$state")" == "$today" ]]; then
  cursor=$(jq -r '.day_cursor // empty' "$state")
  seen=$(jq -c '.day_seen // []' "$state")
else
  cursor=$(jq -r '.last_run // empty' "$state")
  seen=$(jq -c '.message_ids // []' "$state")
fi
if [[ -z "$cursor" ]]; then
  after=$((now - day)) skipped=0 clamped=false
else
  gap=$((now - cursor))
  skipped=$(((gap + 3600) / day - 1))
  ((skipped < 0)) && skipped=0
  if ((gap > 7 * day)); then
    after=$((now - 7 * day)) clamped=true
  else
    after=$((cursor - 3600)) clamped=false
  fi
fi

# Sent mail: the whole last year once, in 12 windows under the 500-message
# page cap, then only what was sent since the last sync.
correspondents="$dir/correspondents.json"
synced=$(jq -r '.sent_synced_until // empty' "$state")
if [[ ! -f "$correspondents" || -z "$synced" ]]; then
  echo '[]' >"$correspondents"
  step=$((365 * day / 12))
  sent_windows=$(jq -n --argjson now "$now" --argjson step "$step" \
    '[range(12) as $i | {after: ($now - (12 - $i) * $step), before: ($now - (11 - $i) * $step)}]')
else
  sent_windows=$(jq -n --argjson after "$((synced - 3600))" '[{after: $after}]')
fi

input="$dir/runs/input-$run_id.json"
output="$dir/runs/result-$run_id.json"
jq -n \
  --arg now "$(date +%Y-%m-%dT%H:%M:%S%z | sed -E 's/([0-9]{2})([0-9]{2})$/\1:\2/')" \
  --arg today "$today" --arg tomorrow "$(day_start 1 | cut -c1-10)" \
  --arg min "$(day_start 0)" --arg max "$(day_start 2)" \
  --argjson after "$after" --argjson skipped "$skipped" --argjson clamped "$clamped" \
  --argjson sent_windows "$sent_windows" --argjson seen "$seen" \
  --slurpfile rules "$rules" --slurpfile correspondents "$correspondents" '{
    now: $now,
    days: [$today, $tomorrow],
    query: "-in:sent -in:chats -in:drafts after:\($after)",
    window: {after: $after, skipped_days: $skipped, clamped: $clamped},
    calendar_window: {time_min: $min, time_max: $max},
    calendar_ids: (["primary"] + ($rules[0].calendars.extra_ids // [])),
    sent_windows: $sent_windows,
    correspondents: $correspondents[0],
    seen_message_ids: $seen,
    rules: $rules[0]
  }' >"$input"

cd "$data"
"$ptc" run "$(basename "$project")" --private-input "$input" --private-output "$output" >/dev/null

date_key=$(jq -r .date "$output")
# Prepare every published file before changing the cursor. A failed render
# leaves the prior page and state intact, so the next run can retry the window.
staging=$(mktemp -d "$dir/.publish.XXXXXXXX")
trap 'rm -rf "$staging"' EXIT
jq 'del(.state, .predictions)' "$output" >"$staging/digest.json"
jq '.predictions' "$output" >"$staging/predictions.json"
jq '.state.correspondents' "$output" >"$staging/correspondents.json"
jq --argjson now "$now" --arg today "$today" --arg cursor "$cursor" --argjson seen "$seen" \
  '{last_run: $now, sent_synced_until: $now, message_ids: .state.message_ids,
    day: $today, day_cursor: (if $cursor == "" then null else ($cursor | tonumber) end), day_seen: $seen}' \
  "$output" >"$staging/state.json"
node "$data/app/scripts/render-digest.mjs" "$staging/digest.json" >"$staging/digest.html"
cp "$staging/digest.html" "$staging/index.html"

mv -f "$staging/digest.json" "$dir/$date_key.json"
mv -f "$staging/predictions.json" "$dir/predictions/$run_id.json"
mv -f "$staging/correspondents.json" "$correspondents"
mv -f "$staging/digest.html" "$data/www/$date_key.html"
mv -f "$staging/index.html" "$data/www/index.html"
rm -f "$input"
# Raw results duplicate what was split out above; keep a month for debugging.
find "$dir/runs" -name 'result-*.json' -mtime +30 -delete
summary=$(jq -r '.counts | "digest: \(.messages) messages, \(.needs_action) need action, \(.events) events"' "$output")
# The cursor is the commit marker: write it only after publication and cleanup.
mv -f "$staging/state.json" "$state"
printf '%s\n' "$summary"
