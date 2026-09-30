#!/usr/bin/env bash
# Sends the synthetic messages in fixtures/decision/ to the decision provider
# from the deployed app (scripts/deploy.sh) and scores the answers. Synthetic
# data only; no mail leaves the box.
#
#   scripts/decision-probe.sh          # replay: offline, no key
#   DECISION_LIVE=1 scripts/decision-probe.sh   # live Jev; needs OPENROUTER_API_KEY
#
# Prints the score summary and the disagreements. Results are kept under
# $PTC_ASSISTANT_DATA/decision-probe/. To refresh the committed replay after a
# prompt change: run live, then scripts/build-decision-replay.mjs.
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

project="$data/decision-probe.ptc-project.json"
[[ -f "$project" ]] || {
  echo "decision-probe: $project is missing; run scripts/deploy.sh" >&2
  exit 1
}
if [[ "${DECISION_LIVE:-}" == 1 ]]; then
  : "${OPENROUTER_API_KEY:?DECISION_LIVE=1 needs OPENROUTER_API_KEY}"
else
  live_project="$data/.decision-probe-replay.ptc-project.json"
  jq '.host.path = "app/workflows/ptc-host.replay.json"' "$project" >"$live_project"
  project=$live_project
fi

with_lock
run_id=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$data/decision-probe"
input="$data/decision-probe/input-$run_id.json"
output="$data/decision-probe/result-$run_id.json"

jq '{batch_size: 10, categories: .categories,
     messages: [.messages[] | del(.needs_action, .category)]}' \
  "$repo/fixtures/decision/messages.json" >"$input"

cd "$data"
"$ptc" run "$(basename "$project")" --input "$input" --output "$output" >/dev/null
node "$repo/scripts/score-decision.mjs" "$output"
