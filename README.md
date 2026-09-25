# ptc-assistant

Single-user personal assistant workflows (mail, calendar, subscriptions) built
on [ptc_runner](https://github.com/andreasronge/ptc_runner), deployed on a
private box and optionally exposed as an OAuth-protected MCP endpoint.

See [SPEC.md](SPEC.md).

## Public repository, private data

This repository is public; the owner's mail-derived data never enters it (see
"Repository boundary" in the spec). After cloning, enable the guard hook:

```sh
git config core.hooksPath scripts/hooks
```

The hook runs `scripts/check-public.sh` and, when installed, `gitleaks`. CI
runs both over every tracked file and the full history.
