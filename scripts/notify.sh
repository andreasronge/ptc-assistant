#!/usr/bin/env bash
# Sends one content-free push through ntfy.sh (SPEC.md, "Delivery"): a fixed
# message and the tailnet link, never mail or calendar content.
#
#   scripts/notify.sh ready|reconnect|failed
#
# NTFY_TOPIC (secret) and DIGEST_URL (the tailnet page) come from the private
# env file. Without NTFY_TOPIC the message is only logged.
set -euo pipefail

case "${1:-}" in
  ready) title="Digest ready" priority=default ;;
  reconnect) title="Reconnect Google" priority=high ;;
  failed) title="Digest run failed" priority=high ;;
  *)
    echo "usage: notify.sh ready|reconnect|failed" >&2
    exit 64
    ;;
esac

if [[ -z "${NTFY_TOPIC:-}" ]]; then
  echo "notify: $title (NTFY_TOPIC unset, not sent)" >&2
  exit 0
fi
curl -fsS --max-time 20 -o /dev/null \
  -H "Title: $title" -H "Priority: $priority" -H "Tags: ptc-assistant" \
  ${DIGEST_URL:+-H "Click: $DIGEST_URL"} \
  -d "$title" "https://ntfy.sh/$NTFY_TOPIC"
