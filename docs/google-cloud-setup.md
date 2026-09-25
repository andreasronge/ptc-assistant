# Google Cloud setup and private credentials

Status checked **25 September 2026**. This page records the current console
state and the safe handoff to the private box. It contains no credential values.

## Current Google Cloud state

| Setting | Value |
| --- | --- |
| Project name | `ptc-assistant` |
| Project ID | `ptc-assistant-509708` |
| Enabled APIs | Gmail API (`gmail.googleapis.com`); Google Calendar API (`calendar-json.googleapis.com`) |
| Google Auth Platform audience | External |
| Publishing status | **Testing** — production publishing is still pending |
| Test users | Owner account only |
| OAuth client | One Desktop app client, named `ptc-assistant desktop` |
| Declared scopes | `https://www.googleapis.com/auth/gmail.readonly`; `https://www.googleapis.com/auth/calendar.readonly` |
| Branding domain | `ptc-runner.dev` |

The owner's account was added as the sole test user on the
[Audience page](https://console.cloud.google.com/auth/audience?project=ptc-assistant-509708).
The owner granted the two read-only scopes in Testing, and the box stored a
refresh token outside the checkout. The live phase 0 probe completed on
25 September 2026: it returned 50 inbox message headers and zero events in
the requested today window. The Calendar call succeeded; zero was the result
for that window. The private result, trace, and inspection files were checked
for owner-only permissions. Google's
[OAuth documentation](https://developers.google.com/identity/protocols/oauth2)
says a refresh token issued for an External app in Testing expires after seven
days unless the app requests only basic identity scopes; this app requests
Gmail and Calendar scopes. Repeat consent if another Testing-mode run is needed
after the token expires. Do not use the Testing token for recurring daily runs.

The Branding page has the planned homepage, privacy policy, and terms URLs
under `https://ptc-runner.dev/ptc-assistant/`. Those pages have been drafted in
the `ptc_runner` site checkout but have **not been published**. Do not switch
the OAuth app to **In production** until the owner approves the exact public
wording and all three pages are live. Before phase 1, publish the app and run
`google-mcp auth` again with `prompt=consent`; verify that the token exchange
returns a new refresh token. Then verify the status on the
[Audience page](https://console.cloud.google.com/auth/audience?project=ptc-assistant-509708)
and update this table. The Google Cloud console is the source of truth if this
dated snapshot differs from it.

## Credential boundary

The Desktop client JSON was downloaded once and moved on the setup Mac to
`$HOME/.config/ptc-assistant/google-oauth-client.json`. That directory is mode
`0700`; the JSON is mode `0600`. It is **outside this checkout**. This file
contains a client secret even though the Desktop client ID itself is public.
Do not print, paste, commit, or attach the JSON. Do not copy it into a
temporary directory inside a checkout, even if `.gitignore` matches its name.

The app runs on the owner's private box. The client JSON and refresh token are
under `$PTC_ASSISTANT_DATA/google/`, with private directories (`0700`) and files
(`0600`). The box has an owner-only environment file outside the checkout that
sets `PTC_ASSISTANT_DATA`, `GOOGLE_MCP_CLIENT_FILE`, and
`GOOGLE_MCP_TOKEN_FILE`. Source it before running `google-mcp auth` or
`scripts/probe.sh`. These paths are runtime configuration, not constants in
source code. Replace the phase 0 Testing token after publishing. See
[SPEC.md](../SPEC.md#google-oauth) for the loopback and SSH-tunnel design.

The owner granted Gmail and Calendar access through the consent flow. The app
must keep requesting only the two read-only scopes above, and must never log
the authorization code, access token, refresh token, client JSON, or
message/calendar content.

## Before a commit or deployment

1. Keep all real rules, state, reports, traces, env files, and Google
   credentials under `$PTC_ASSISTANT_DATA` on the box, never under the public
   checkout. The paths in [`.gitignore`](../.gitignore) and the staged-file
   guard are defense in depth.
2. Run `git status --short` and inspect every added file. Run
   `scripts/check-public.sh` after staging. The pre-commit hook runs that
   check and `gitleaks` when installed; CI checks tracked files and history.
3. If a credential or token enters a commit or public channel, treat it as
   exposed: revoke or rotate it and remove the value from every published
   surface. Deleting a later commit is not enough to make an exposed secret
   safe again.

Google's [OAuth consent guidance](https://developers.google.com/workspace/guides/configure-oauth-consent)
and [personal-use verification guidance](https://support.google.com/cloud/answer/13464323)
explain the External/production setup and the unverified-app warning. The
project's intended access and data flow are described in [SPEC.md](../SPEC.md).
