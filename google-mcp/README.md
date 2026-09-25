# google-mcp

A read-only Gmail and Google Calendar MCP server over stdio (MCP 2026-07-28),
launched by ptc on the private box. It asks only for `gmail.readonly` and
`calendar.readonly` and has no tool that can send, modify, or delete. See
[SPEC.md](../SPEC.md#upstream-own-gmail-and-calendar-mcp-server).

| Tool              | Returns                                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_messages` | metadata for a Gmail query: ids, sender, parsed recipient addresses, subject, snippet, label ids, `List-Unsubscribe`/`Precedence`/`Auto-Submitted` |
| `list_events`     | events in a window over the primary and any named calendars, with attendee addresses, `with_others`, `has_agenda`                                  |

Lists return at most 100 items a page and 500 across all pages; follow
`next_cursor` until it is null.

## Configuration

Both paths are private and live under `$PTC_ASSISTANT_DATA/google/`, mode 0600:

- `GOOGLE_MCP_CLIENT_FILE`: the Desktop OAuth client JSON.
- `GOOGLE_MCP_TOKEN_FILE`: the refresh token, written by `google-mcp auth`.

The server refuses a client or token file that anyone but the owner can read.
It never logs the authorization code, tokens, or the client secret.

## Consent on the box

```sh
pnpm install && pnpm run build
node dist/cli.js auth            # listens on 127.0.0.1:8765
```

From the laptop, `ssh -L 8765:127.0.0.1:8765 <box>` over Tailscale, then open
the printed URL in the laptop browser and grant both scopes. The command fails
unless Google returns a refresh token that has both scopes and nothing more.

If the token is missing or revoked, every tool call answers `reconnect Google`;
nothing retries it.

## Development

```sh
pnpm run verify   # prettier, typecheck, tests
```

The tests run the real tools over stdio against a fake Google
(`test/helpers/fake-serve.mjs`). The same fake backs
`workflows/ptc-host.fake.json`, so the deployed ptc probe can run without
credentials:

```sh
export PTC_ASSISTANT_DATA=/some/private/dir
scripts/deploy.sh && PROBE_HOST=fake scripts/probe.sh
```
