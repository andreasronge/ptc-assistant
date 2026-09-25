#!/usr/bin/env bash
# Installs systemd user timers for the daily run (06:45) and trace pruning
# (03:30), Europe/Stockholm. Persistent timers catch up a run the host missed
# while it was off; logs go to the journal:
#
#   journalctl --user -u ptc-assistant-daily
#   systemctl --user list-timers 'ptc-assistant-*'
#
#   scripts/install-timers.sh ENV_FILE    # install or update, then enable
#   scripts/install-timers.sh --remove    # disable and delete the units
#
# ENV_FILE is the private environment file (PTC_ASSISTANT_DATA, the Google
# paths, NTFY_TOPIC, DIGEST_URL). User timers run without a login session only
# when lingering is on: `sudo loginctl enable-linger "$USER"`.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
units=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
names=(ptc-assistant-daily ptc-assistant-prune)

if [[ "${1:-}" == "--remove" ]]; then
  for name in "${names[@]}"; do
    systemctl --user disable --now "$name.timer" 2>/dev/null || true
    rm -f "$units/$name.service" "$units/$name.timer"
  done
  systemctl --user daemon-reload
  exit 0
fi

env_file=${1:?usage: install-timers.sh ENV_FILE | --remove}
env_file=$(cd "$(dirname "$env_file")" && pwd)/$(basename "$env_file")
[[ -f "$env_file" ]] || { echo "install-timers: no env file at $env_file" >&2; exit 1; }
[[ "$(stat -c %a "$env_file" 2>/dev/null || stat -f %Lp "$env_file")" == 600 ]] ||
  { echo "install-timers: $env_file must be mode 0600" >&2; exit 1; }
if command -v loginctl >/dev/null && [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]]; then
  echo "install-timers: lingering is off, so timers stop when you log out; run: sudo loginctl enable-linger $USER" >&2
fi

mkdir -p "$units"

# $1 unit name, $2 script, $3 description, $4 time of day
write_unit() {
  cat >"$units/$1.service" <<EOF
[Unit]
Description=ptc-assistant: $3

[Service]
Type=oneshot
# The env file uses shell syntax (export lines), so it is sourced, not read
# with EnvironmentFile=.
ExecStart=/bin/bash -c 'set -a && . "\$0" && exec "\$1"' $env_file $repo/scripts/$2
Nice=10
EOF
  cat >"$units/$1.timer" <<EOF
[Unit]
Description=ptc-assistant: $3

[Timer]
OnCalendar=*-*-* $4 Europe/Stockholm
Persistent=true
RandomizedDelaySec=60

[Install]
WantedBy=timers.target
EOF
}

write_unit ptc-assistant-daily run-daily.sh "daily digest" 06:45:00
write_unit ptc-assistant-prune prune.sh "trace pruning" 03:30:00

systemctl --user daemon-reload
for name in "${names[@]}"; do systemctl --user enable --now "$name.timer" >/dev/null; done
systemctl --user list-timers --no-pager 'ptc-assistant-*'
