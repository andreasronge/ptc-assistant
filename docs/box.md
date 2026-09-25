# Running on the box

This is the generic procedure for any private Linux host. The facts of one
concrete deployment (host name, SSH alias, tailnet URL, paths, what else runs
on the host, dates such as token expiry) are **not** recorded in this public
repository: keep them in `$PTC_ASSISTANT_DATA/DEPLOYMENT.md` on the host,
beside the data they describe, and update that file whenever the deployment
changes.

The private box is Ubuntu 24.04. It needs `git`, `mise` (for the pinned
Erlang/Elixir), Node.js 20.19 or newer, `pnpm`, `jq`, `rsync`, and `flock`.
All private state lives in `$PTC_ASSISTANT_DATA` (mode `0700`), outside this
checkout; see [google-cloud-setup.md](google-cloud-setup.md) for the
credential files and the environment file that sets the paths.

## Build, deploy, run

Work on the host over SSH (through Tailscale), in a git clone of this
repository:

```sh
ssh <host>
cd <checkout> && git pull --ff-only
source <private env file>
scripts/build-ptc.sh        # pinned ptc_runner -> releases/<sha>/, releases/current
scripts/deploy.sh           # workflows + google-mcp -> $PTC_ASSISTANT_DATA/app/
scripts/probe.sh            # counts only; the result stays private
scripts/digest.sh           # one digest run (run-daily.sh adds the push)
```

- **Upgrade ptc:** change `PTC_RUNNER_SHA` in a commit, pull, run
  `scripts/build-ptc.sh`.
- **Roll back ptc:** `scripts/build-ptc.sh --list`, then `--rollback <sha>`.
- **Deploy changes:** commit, pull, run `scripts/deploy.sh`. It refuses a
  dirty checkout and records the commit in `app/DEPLOYED.json`. Nothing in the
  checkout affects a run until then.
- **Offline check:** `PROBE_HOST=fake scripts/probe.sh` and
  `DIGEST_HOST=fake scripts/digest.sh` use the fake Google.
- **Rules:** `$PTC_ASSISTANT_DATA/rules/mail.json` follows
  `rules/mail.example.json`; `owner.addresses` must list every address the
  owner receives mail at, and `calendars.extra_ids` any shared calendars.

Every script that runs a workflow or replaces the app takes
`$PTC_ASSISTANT_DATA/run.lock`, so runs never overlap and a deploy never swaps
the app under a running workflow.

## Layout under `$PTC_ASSISTANT_DATA`

```text
DEPLOYMENT.md           this deployment's host-specific record (private)
app/                    deployed copy of workflows/ and google-mcp/
<name>.ptc-project.json one per workflow, written by deploy
ptc/                    shared artifact root: traces/, inspection/, envelopes/, results/, keep/
google/                 OAuth client JSON and refresh token (0600)
rules/                  private rules repository (mail.json)
digest/                 <date>.json, predictions/, state.json, correspondents.json, runs/
www/                    <date>.html and index.html, served on the tailnet only
probe/                  probe inputs and results
```

## Delivery

Serve the page on the tailnet only, and never with `tailscale funnel`:

```sh
sudo tailscale serve --bg --set-path /digest "$PTC_ASSISTANT_DATA/www"
tailscale serve status   # other handlers on the host must be unchanged
```

`--set-path` adds a handler beside any the host already serves. `tailscaled`
reads the owner-only files as root. Put these in the private env file:

- `DIGEST_URL`: the tailnet URL of `index.html`, used as the push's click link.
- `NTFY_TOPIC`: the secret ntfy.sh topic. The push says only "Digest ready",
  "Reconnect Google", or "Digest run failed". Without it, nothing is sent.

## Schedule

```sh
sudo loginctl enable-linger "$USER"   # user timers run without a login session
scripts/install-timers.sh <private env file>
systemctl --user list-timers 'ptc-assistant-*'
journalctl --user -u ptc-assistant-daily
```

`scripts/install-timers.sh` writes systemd user units that run
`scripts/run-daily.sh` at 06:45 and `scripts/prune.sh` at 03:30,
Europe/Stockholm. The timers are persistent, so a run the host missed while
it was down happens at the next boot. `--remove` uninstalls them. To run the
digest now: `systemctl --user start ptc-assistant-daily`.

`scripts/prune.sh` keeps 30 days and at most 5 GB of runs. To keep a run past
the window, create an empty `ptc/keep/<run_ref>`. `run-daily.sh` checks the
Google token first (`google-mcp check`), so an expired or revoked token sends
"Reconnect Google" rather than "Digest run failed".
