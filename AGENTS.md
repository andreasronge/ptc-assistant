# Guidance for coding assistants

Read [SPEC.md](SPEC.md) for the intended architecture and
[docs/google-cloud-setup.md](docs/google-cloud-setup.md) for the actual Google
Cloud setup and its current status.

This is a public repository. Keep OAuth client JSON, client secrets, refresh
tokens, real mail/calendar data, rules, traces, reports, and private env files
outside the checkout. Use `$PTC_ASSISTANT_DATA` on the private box.
Host-specific deployment facts (host names, SSH aliases, tailnet URLs, paths)
belong in the private `$PTC_ASSISTANT_DATA/DEPLOYMENT.md` on that host, not
in this repository; [docs/box.md](docs/box.md) stays generic. Do not paste
credential values into code, documentation, tests, issues, logs, tool output,
or pull requests. An OAuth client ID and Google Cloud project ID may be public,
but there is no need to copy the client ID into source files.

Before committing, run `scripts/check-public.sh` on staged files and check
`git status --short`. The configured pre-commit hook also runs `gitleaks` when
available; CI scans the full history. Ignore rules and scanners are backups,
not permission to put private files under this repository.

Do not assume the Google OAuth app is in production until the status in
[docs/google-cloud-setup.md](docs/google-cloud-setup.md) is updated from a
verified console state. Do not request broader Gmail or Calendar scopes than
the two read-only scopes listed there.
