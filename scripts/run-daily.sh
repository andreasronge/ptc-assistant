#!/usr/bin/env bash
# The one daily cron entry (SPEC.md, "Scheduling"): runs the workflows in
# order under the run lock, then sends one content-free push.
#
#   CRON_TZ=Europe/Stockholm
#   45 6 * * * . <private env file> && <checkout>/scripts/run-daily.sh >> "$PTC_ASSISTANT_DATA/cron.log" 2>&1
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

here=$(dirname "$0")
with_lock
echo "run-daily: $(date -u +%FT%TZ)"

# Week 2 adds the oracle before the digest.
status=0
"$here/digest.sh" || status=$?
case $status in
  0) notice=ready ;;
  3) notice=reconnect ;;
  *) notice=failed ;;
esac
notify_status=0
"$here/notify.sh" "$notice" || notify_status=$?
if [[ -z "${NTFY_TOPIC:-}" ]]; then
  echo "run-daily: push skipped (NTFY_TOPIC unset)"
elif ((notify_status == 0)); then
  echo "run-daily: push sent ($notice)"
else
  echo "run-daily: push failed (exit $notify_status)" >&2
fi
((notify_status == 0)) || exit "$notify_status"
exit "$status"
