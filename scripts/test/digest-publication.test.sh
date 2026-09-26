#!/usr/bin/env bash
# A failed page render must not publish a partial digest or advance the cursor.
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/ptc-digest-test.XXXXXXXX")
trap 'rm -rf "$test_dir"' EXIT
data="$test_dir/data"
mkdir -p "$data/app/scripts" "$data/rules" "$data/www" "$data/digest"
echo '{}' >"$data/rules/mail.json"
echo '{}' >"$data/digest.ptc-project.json"
echo '{"last_run": 1234567890, "sent_synced_until": 1234567890, "message_ids": ["previous"]}' >"$data/digest/state.json"
cp "$data/digest/state.json" "$test_dir/previous-state.json"

date_key=$(TZ=Europe/Stockholm date +%F)
jq -n --arg date "$date_key" '{
  date: $date, generated_at: "2026-09-26T06:45:00+02:00",
  calendar: {days: [], overlaps: []},
  needs_action: [], unsettled: [], bulk: [], receipts: [],
  counts: {messages: 1, needs_action: 0, unsettled: 0, bulk: 0, events: 0},
  predictions: [{message_id: "example-message", layer: "rules"}],
  state: {correspondents: [], message_ids: ["example-message"]}
}' >"$test_dir/result.json"

cat >"$test_dir/ptc" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
while (($#)); do
  if [[ "$1" == --private-output ]]; then
    cp "$FIXTURE_PATH" "$2"
    exit 0
  fi
  shift
done
exit 64
EOF
chmod +x "$test_dir/ptc"
printf 'old page\n' >"$data/www/index.html"
printf 'old dated page\n' >"$data/www/$date_key.html"
printf 'process.exit(17)\n' >"$data/app/scripts/render-digest.mjs"

run_digest() {
  DIGEST_HOST=fake PTC_ASSISTANT_LOCKED=1 PTC_ASSISTANT_DATA="$data" \
    PTC_BIN="$test_dir/ptc" FIXTURE_PATH="$test_dir/result.json" \
    "$repo/scripts/digest.sh"
}

status=0
run_digest >"$test_dir/failed.stdout" 2>"$test_dir/failed.stderr" || status=$?
[[ "$status" == 17 ]]
cmp "$test_dir/previous-state.json" "$data/digest/state.json"
[[ "$(cat "$data/www/index.html")" == 'old page' ]]
[[ "$(cat "$data/www/$date_key.html")" == 'old dated page' ]]
[[ ! -e "$data/digest/$date_key.json" ]]

cp "$repo/scripts/render-digest.mjs" "$data/app/scripts/render-digest.mjs"
run_digest >"$test_dir/success.stdout" 2>"$test_dir/success.stderr"
jq -e '.last_run > 0 and .message_ids == ["example-message"]' "$data/digest/state.json" >/dev/null
jq -e --arg date "$date_key" '.date == $date' "$data/digest/$date_key.json" >/dev/null
cmp "$data/www/$date_key.html" "$data/www/index.html"
[[ "$(cat "$data/www/index.html")" != 'old page' ]]

DIGEST_HOST=fake PTC_ASSISTANT_LOCKED=1 PTC_ASSISTANT_DATA="$data" \
  PTC_BIN="$test_dir/ptc" FIXTURE_PATH="$test_dir/result.json" \
  "$repo/scripts/run-daily.sh" >"$test_dir/daily.stdout" 2>"$test_dir/daily.stderr"
grep -Fq 'run-daily: push skipped (NTFY_TOPIC unset)' "$test_dir/daily.stdout"
echo 'digest publication test passed'
