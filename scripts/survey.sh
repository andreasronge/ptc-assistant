#!/usr/bin/env bash
# One-off mail metadata survey: fetches sender, subject, labels and flags (no
# snippets, no bodies) for the last N weeks, then prints counts only. Used to
# draft email categories. Everything stays under $PTC_ASSISTANT_DATA.
#
#   SURVEY_WEEKS=13 scripts/survey.sh        # default 13 weeks
#   SURVEY_HOST=fake scripts/survey.sh       # against the fake Google
#   SURVEY_CHUNK_WEEKS=1 SURVEY_PAUSE_S=20 GOOGLE_MCP_FETCH_CONCURRENCY=2 scripts/survey.sh   # gentle on Gmail quotas
#
# Runs from its own staging copy ($PTC_ASSISTANT_DATA/survey-app) built from the
# already deployed google-mcp, so it never touches the deployed digest app.
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

weeks=${SURVEY_WEEKS:-13}
deployed="$data/app"
[[ -d "$deployed/google-mcp" ]] || {
  echo "survey: $deployed/google-mcp is missing; run scripts/deploy.sh" >&2
  exit 1
}

host="$deployed/workflows/ptc-host.json"
[[ "${SURVEY_HOST:-}" == "fake" ]] && host="$deployed/workflows/ptc-host.fake.json"

with_lock
staging="$data/survey-app"
rm -rf "$staging"
mkdir -p "$staging/workflows"
rsync -a "$repo/workflows/survey" "$staging/workflows/"
cp "$host" "$staging/workflows/ptc-host.json"
rsync -a "$deployed/google-mcp" "$staging/"
# Optional overlay of a newer built dist (for example the 403 rate-limit retry) without touching the deployed app.
[[ -d "$repo/google-mcp-dist" ]] && rsync -a "$repo/google-mcp-dist/" "$staging/google-mcp/dist/"

project="$data/survey.ptc-project.json"
jq -n '{kind: "ptc-project", version: 1,
        application: {path: "survey-app/workflows/survey/ptc.json"},
        host: {path: "survey-app/workflows/ptc-host.json"},
        artifacts: {root: "ptc-survey", trace: true, inspection: true, result: false}}' >"$project"

run_id=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$data/survey"
output="$data/survey/result-$run_id.json"
now=$(date +%s)
chunk=${SURVEY_CHUNK_WEEKS:-2} # weeks per ptc run, to stay inside the run limits
cd "$data"
parts=()
failed=()
for ((start = 0; start < weeks; start += chunk)); do
  end=$((start + chunk < weeks ? start + chunk : weeks))
  part_in="$data/survey/input-$run_id-$start.json"
  part_out="$data/survey/part-$run_id-$start.json"
  jq -n --argjson now "$now" --argjson from "$start" --argjson to "$end" \
    '{query: "-in:sent -in:drafts -in:chats -in:spam -in:trash",
      windows: [range($from; $to) | {after: ($now - (. + 1) * 604800), before: ($now - . * 604800)}]}' >"$part_in"
  attempt=1
  until "$ptc" run "$(basename "$project")" --private-input "$part_in" --private-output "$part_out" >/dev/null 2>"$data/survey/last-error.txt"; do
    if ((attempt >= ${SURVEY_RETRIES:-4})); then
      echo "survey: weeks $start-$((end - 1)) failed after $attempt attempts: $(head -c 200 "$data/survey/last-error.txt")" >&2
      failed+=("$start")
      break
    fi
    attempt=$((attempt + 1))
    sleep "${SURVEY_RETRY_WAIT_S:-90}" # Gmail quotas recover with time
  done
  [[ -s "$part_out" ]] && parts+=("$part_out")
  sleep "${SURVEY_PAUSE_S:-0}"
done
((${#parts[@]} > 0)) || {
  echo "survey: no week could be fetched" >&2
  exit 1
}
jq -s '{windows: (map(.windows) | add), messages: (map(.messages) | add)}' "${parts[@]}" >"$output"
rm -f "${parts[@]}" "$data"/survey/input-"$run_id"-*.json
node "$repo/scripts/survey-aggregate.mjs" "$output" | tee "$data/survey/aggregate-$run_id.json"
((${#failed[@]} == 0)) || echo "survey: incomplete, weeks starting at offsets ${failed[*]} are missing" >&2
