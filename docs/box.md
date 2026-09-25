# Running on the box

The private box is Ubuntu 24.04. It needs `git`, `mise` (for the pinned
Erlang/Elixir), Node.js 20.19 or newer, `pnpm`, `jq`, `rsync`, and `flock`.
All private state lives in `$PTC_ASSISTANT_DATA` (mode `0700`), outside this
checkout; see [google-cloud-setup.md](google-cloud-setup.md) for the
credential files and the environment file that sets the paths.

## Build, deploy, run

```sh
source <private env file>
scripts/build-ptc.sh        # pinned ptc_runner -> releases/<sha>/, releases/current
scripts/deploy.sh           # workflows + google-mcp -> $PTC_ASSISTANT_DATA/app/
scripts/probe.sh            # counts only; the result stays private
```

- **Upgrade ptc:** change `PTC_RUNNER_SHA` in a commit, pull, run
  `scripts/build-ptc.sh`.
- **Roll back ptc:** `scripts/build-ptc.sh --list`, then `--rollback <sha>`.
- **Deploy changes:** commit, pull, run `scripts/deploy.sh`. It refuses a
  dirty checkout and records the commit in `app/DEPLOYED.json`. Nothing in the
  checkout affects a run until then.
- **Offline check:** `PROBE_HOST=fake scripts/probe.sh` uses the fake Google.

Every script that runs a workflow or replaces the app takes
`$PTC_ASSISTANT_DATA/run.lock`, so runs never overlap and a deploy never swaps
the app under a running workflow.

## Layout under `$PTC_ASSISTANT_DATA`

```text
app/                    deployed copy of workflows/ and google-mcp/
<name>.ptc-project.json one per workflow, written by deploy
ptc/                    shared artifact root: traces/, inspection/, envelopes/, results/, keep/
google/                 OAuth client JSON and refresh token (0600)
rules/                  private rules repository (mail.json)
probe/                  probe inputs and results
```

## Cron

```cron
CRON_TZ=Europe/Stockholm
30 3 * * * . <private env file> && <checkout>/scripts/prune.sh >> "$PTC_ASSISTANT_DATA/cron.log" 2>&1
```

`scripts/prune.sh` keeps 30 days and at most 5 GB of runs. To keep a run past
the window, create an empty `ptc/keep/<run_ref>`. The daily workflow entry
(`scripts/run-daily.sh`) is added with the digest.
