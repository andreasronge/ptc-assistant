# ptc-assistant — specification

Status: draft, 2026-09-25. Single user (the owner). Public repository; the
owner's data stays private (see Repository boundary).

## Purpose

1. **Replace the xAI Grok bots** that currently analyze the owner's mail,
   calendar, and paid subscriptions, with PTC workflows the owner controls.
2. **Produce real, daily usage traces for ptc_runner.** Every run is traced, so
   bugs and improvements in ptc_runner are found from real data instead of
   smoke runs and benchmarks.

Success after phase 1 (two independent clocks):

- **Usefulness**, starting week 1: the owner reads the rules-only digest
  instead of the Grok output for two consecutive weeks. If the simplest
  digest is not worth reading, the model layers will not rescue it.
- **Improvement**, measured by the oracle: each model layer that is kept beats
  the previous one on the same messages (see Oracle), and the owner has
  reviewed and filed at least one ptc_runner issue drafted from real traces.

## Non-goals

- Multiple users or tenants.
- Work accounts. Corporate mail through external
  models and onto a personal machine is a company data-policy question, not a
  technical one. Revisit only with the company's approval, as a second
  upstream binding.
- Sending, deleting, labelling, or otherwise modifying mail or calendar data.
- Browser automation (sites without an API). `ptc-web` may cover reading such
  pages later.
- A web UI beyond the existing ptc Viewer.

## Repository boundary (public repository)

This repository is public. It holds only generic parts: `google-mcp/`,
workflow manifests that take rules and state as input, scripts, this
specification, and example rules whose senders use reserved example domains.

**Personal data never enters it:** real rules (`rules/mail.edn` names the
owner's vendors and correspondents), workflow state, predictions, reports,
traces, env files, OAuth tokens, and the ntfy topic. On the box they live in a
private directory outside the checkout (`$PTC_ASSISTANT_DATA`, mode 0700),
which the cron scripts pass to workflows through `--input`/`--output`.

- **Rules** are versioned in a private git repository at
  `$PTC_ASSISTANT_DATA/rules/` (no remote, or a private one). Accepting a
  proposal means committing its diff there. This public repository carries
  `rules/mail.example.edn`, which documents the schema with senders at
  reserved example domains.
- **Reports** and issue drafts live in `$PTC_ASSISTANT_DATA/reports/`, always.

Guardrails, both required to pass:

- `scripts/check-public.sh` refuses any email address outside reserved
  example domains and any file under a personal-data path; it runs from the
  pre-commit hook (`git config core.hooksPath scripts/hooks`) and in CI.
- `gitleaks` scans commits in the pre-commit hook and the full history in CI.

## Architecture

```
PUBLIC (MCP only)
  claude.ai web/mobile, Claude Code, cloud agents
     │  MCP 2026-07-28 + OAuth 2.1 (PKCE S256, resource indicator)
     ▼
  Cloudflare Worker on mcp.ptc-runner.dev   (workers-oauth-provider; login via GitHub; allowlist = owner)
     │  forwards with the gateway's static bearer
     ▼
  Cloudflare Tunnel (cloudflared, outbound from the box)
─────────────────────────────────────────────────────────────────────
PRIVATE (the owner's always-on box, reached over Tailscale)
  ptc gateway, 127.0.0.1           serves pinned read-only tools
  cron: ptc run digest / ledger    scheduled workflows, traced
  cron: ptc prune                  rolling trace window
  cron: analysis REPL              nightly findings over traces
  ptc viewer                       tailnet only, via `tailscale serve`
     │
     ▼
  google-mcp (own stdio MCP server, this repo) ──> Gmail + Calendar REST APIs
  OpenRouter (LLM, decision models)          ntfy (push to the owner's phone)
```

Rules:

- The **only public surface is the MCP endpoint**. The Viewer, REPL, traces,
  and all credentials stay on the box, reachable only over the tailnet.
- **Observer separate from observed.** The analysis run is a separate process
  from the workflows it analyzes and never shares their credentials.
- The tunnel origin must not be reachable without passing the Worker: the
  gateway's static bearer is held only by the Worker; optionally add a
  Cloudflare Access service token, or use Workers VPC if available.

## Components

### ptc_runner build

- `PTC_RUNNER_SHA` in this repo names the exact ptc_runner main commit
  deployed. Deploying means changing that line in a commit.
- `scripts/build-ptc.sh` checks out the SHA on the box, runs
  `MIX_ENV=prod mix release`, installs into `releases/<sha>/`, and repoints a
  `current` symlink. The box is Ubuntu 24.04 (checked 2026-09-25). ptc_runner's
  standalone packaging script is macOS-only and exists to make a binary
  portable; a release built on the box that only runs there needs none of it.
- Rollback: repoint `current` to a kept earlier build (keep the last 3).
- `ptc --version` prints the SHA, so traces are attributable to a build.

### Workflows (phase 1, run by cron via `ptc run`)

Each is a ptc manifest in `workflows/<name>/`, run with
`--trace-dir` and `--inspect` so normal and private traces are written.

**State moves through files, never through filesystem grants.** A cron script
per workflow assembles the input (rules, previous predictions, previous
ledger) into one JSON file passed with `--input`, and stores the result
written by `--output`. Workflows hold no filesystem capability and no
`ptc-fs-mcp`. `--input` accepts only manifest-relative paths, so each
workflow's `state/` directory is a symlink into `$PTC_ASSISTANT_DATA` (the
link target is outside the checkout; `state/` is git-ignored). Verify in
phase 0 that ptc's input confinement accepts that link; if it does not, the
cron script copies the input in and the output out.

**Delivery (phase 1): no mail content leaves the box for delivery.** The
digest is rendered as a page served only on the tailnet (`tailscale serve`).
A push through public ntfy.sh carries only content-free text ("digest ready",
"reconnect Google", "run failed") plus the tailnet link; the phone opens it
through the Tailscale app. The topic name is still a secret, but a leaked
topic reveals nothing about mail.

**Scheduling.** Dates and "today" are Europe/Stockholm (the box clock is UTC;
cron uses `CRON_TZ=Europe/Stockholm`). One cron entry runs
`scripts/run-daily.sh` at 06:45 under `flock`, which runs the workflows
sequentially: oracle → digest → ledger. Runs never overlap, so only one
`google-mcp` process uses the token at a time. `google-mcp` still takes an
exclusive file lock around token refresh and writes the token file
atomically, so a manual run during cron cannot corrupt it.

1. **Daily digest** (≈07:00). Calendar summary for today and tomorrow
   (overlaps, external attendees, events without agenda); person mail that
   likely needs action; bulk mail as counts per sender; receipt candidates.
   Output: a JSON result plus a rendered page, stored under
   `workflows/digest/state/<date>.json`, served on the tailnet, announced by a
   content-free push. Every classification the digest makes is also recorded
   as a prediction (below).
2. **Subscription ledger** (daily, incremental; week 4). Program narrows mail to
   likely receipts and renewal notices and extracts
   `{vendor, amount, currency, period, renewal_date, source_message_id}` per
   message. **v0 is regex-only**: sender → vendor map (in the private rules)
   and amount/currency/date patterns run on the body *inside the program*, so
   no body leaves the box. Messages the patterns cannot parse are listed as
   "unparsed". A chat model extracts only those, under a strict JSON schema,
   and only once a ZDR chat provider is verified (see Models). The program
   deduplicates and merges
   into `workflows/ledger/state/ledger.json`, flagging new vendors, price changes, and
   subscriptions with no receipt in their expected period. The previous
   ledger arrives through `--input`; the new ledger leaves through `--output`.
3. **Oracle** (daily). Scores predictions that are exactly 5 days old
   against the owner's observed behaviour (definition under Oracle) and
   appends precision/recall to
   `workflows/oracle/state/<date>.json` (below).

Design principle: programs filter and aggregate. Every model question
concerns exactly one message; many such questions may travel in one batched
request, but no question spans several messages. Mail bodies never enter a
model context together.

### Classification

Layered, cheapest first. Each layer must beat the previous one on the oracle
before it is kept.

1. **Rules (week 1, no model).** Data in the private rules repository
   (`$PTC_ASSISTANT_DATA/rules/mail.edn`; schema in `rules/mail.example.edn`):
   - bulk: `List-Unsubscribe` header, `noreply`-style senders, Gmail
     Promotions/Social/Updates categories → counted per sender, not listed;
   - person: sender the owner has written to before (from sent mail);
   - Gmail's `IMPORTANT` label (Google's own classifier, trained on the
     owner's behaviour; see the bias note under Oracle);
   - awaiting reply: last message in the thread is not the owner's and is
     addressed directly to the owner;
   - receipt candidates: sender/subject patterns (English and Swedish, e.g.
     `receipt|invoice|renewal|subscription|payment|kvitto|faktura`) and an
     amount/currency pattern.
2. **Decision model on the residue (week 3).** Mail no rule settles goes to a
   `decision/request` provider (first backend: Jev via OpenRouter): one
   question per message, a boolean "needs the owner's action" and a choice
   over the committed categories, batched in one request. The provider returns
   probabilities; the workflow applies a visible threshold in PTC-Lisp.
   Probabilities between 0.3 and 0.7 go to a "not sure" section of the
   digest. Input is **sender, subject, label ids, and header flags only**. The
   Gmail snippet is body text (its first ~200 characters), so it is not sent
   until written ZDR confirmation exists (Open question 6).
3. **Chat model only for generation** (ledger extraction, optional two-line
   summaries of action items).

**Oracle.** `gmail.readonly` shows what the owner actually did. One definition:

- *needs action* = the owner replied within 72 h of receipt, or starred it;
- *no action* = neither, and the message was archived or read by day 5;
- *undecided* = still unread and unarchived on day 5; excluded from scores;
- predictions are scored when they are exactly 5 days old.

Each digest records its predictions (message id, layer, label, probability).

**Bias, stated honestly.** The labels are not independent of the classifier:
the digest the owner reads shapes what gets replied to and starred, and
actions outside Gmail (phone, chat, bank app) look like "no action". So:

- absolute precision/recall are indicative, not ground truth;
- layers are compared **on the same messages in shadow mode**: every layer
  classifies every message; the digest shows one layer (the current
  baseline); a candidate layer runs unseen for at least one week before it
  may be shown. The shown layer is favoured by the feedback loop, which makes
  the comparison conservative for the candidate;
- once the ledger exists, an invoice counts as handled when a matching
  payment receipt arrives.

**Categories are proposed offline, never drift daily.**

- Bootstrap (week 2, once): an LLM sees metadata only (sender, subject,
  labels, reply rate) for the last 90 days and proposes 6–10 categories plus
  rules. The owner edits them and commits to the private rules repository.
- Weekly proposal run: from "not sure" items and oracle misses, proposes a
  diff to the private `mail.edn`, replayed over stored history so the proposal
  carries before/after precision and recall. The owner accepts or rejects.

### Gateway tools (phase 2)

Read-only, pinned, served by `ptc gateway` on loopback:

- `digest.today` — returns the stored digest for a date (default today).
- `ledger.query` — filters the stored ledger (vendor, period, status).

Every served tool returns a complete result in one call. claude.ai does not
yet retry the MCP input-required flow (anthropics/claude-ai-mcp#1027).

### Upstream: own Gmail and Calendar MCP server

Google's official Gmail and Calendar MCP servers
(`gmailmcp`/`calendarmcp.googleapis.com/mcp/v1`) require the Google Workspace
Developer Preview Program, which requires a Workspace account; a personal
account is not eligible (research 2026-09-25). They also expose an issuer
mismatch that ptc_runner rejects (#2091). So this repository ships its own
server, `google-mcp/`:

- **Transport:** stdio, MCP 2026-07-28, started by ptc as an MCP source on
  the box. No network listener and no OAuth between ptc and the server.
- **Language:** TypeScript, following `ptc-fs-mcp` and `ptc-web`, which
  already interoperate with ptc_runner.
- **Read-only by construction:** only read tools exist.

| Tool | Returns |
| --- | --- |
| `search_messages` | ids, thread ids, date, from, to, subject, snippet, label ids, and the headers the rules need (`List-Unsubscribe`, `Precedence`, `Auto-Submitted`) for a Gmail query, paginated and capped |
| `get_message` | the same fields plus a size-capped plain-text body (only called for extraction) |
| `list_sent_recipients` | distinct addresses the owner has written to within a window |
| `list_labels` | label ids and names |
| `list_events` | events in a time window: time, title, attendees (with external flag), location, has-agenda |
| `get_event` | one event in full |

Results are trimmed to what workflows need, so payloads stay small. The
server holds the Google refresh token itself.

### Google OAuth

This section describes the target setup. The verified current console state,
pending production step, and private credential location are recorded in
[docs/google-cloud-setup.md](docs/google-cloud-setup.md).

- The owner's own Google Cloud project with the Gmail and Calendar APIs
  (`gmail.googleapis.com`, `calendar-json.googleapis.com`) enabled; scopes
  `gmail.readonly` and `calendar.readonly`.
- OAuth client type **Desktop app**: Google returns refresh tokens to
  installed-app clients by default and allows a loopback redirect on any
  port. User type **External**, publishing status **In production,
  unverified**. Never "Testing": refresh tokens then expire after 7 days.
- Sole-user apps are exempt from restricted-scope verification (Google lists
  "you are the only user of your app"). The owner clicks through the
  unverified-app warning once.
- One-time consent: `google-mcp auth` runs the loopback flow on the box; the
  owner reaches the loopback port through an SSH tunnel over Tailscale. The
  refresh token is stored on the box, mode 0600, outside the repository.
- `invalid_grant` on refresh is terminal: the server fails every call with a
  clear "reconnect Google" error and the cron script pushes a re-consent
  notice. No retry loop (Google keeps 100 refresh tokens per client and
  silently revokes the oldest). A Gmail password change revokes the token.

### Public MCP endpoint and OAuth (phase 2)

- Hostname `mcp.ptc-runner.dev`. DNS is on Cloudflare; the docs site on the
  apex (GitHub Pages) is unaffected. Cookies are host-only on the subdomain.
- Cloudflare Worker using `workers-oauth-provider`: publishes RFC 9728
  protected-resource metadata (`resource` exactly
  `https://mcp.ptc-runner.dev/mcp`) and RFC 8414 authorization-server
  metadata; answers unauthenticated requests with `401` +
  `WWW-Authenticate: Bearer resource_metadata=...`.
- Client registration: advertise CIMD
  (`client_id_metadata_document_supported: true`, `"none"` in
  `token_endpoint_auth_methods_supported`) so claude.ai uses its published
  identity; DCR as fallback. claude.ai callback:
  `https://claude.ai/api/mcp/auth_callback`; Claude Code uses a loopback
  callback.
- PKCE S256; validate `aud` against the resource; rotate refresh tokens;
  `/token` accepts form bodies and answers within 10 s.
- Scopes derive from compiled effects: `tools:read` sees read-effect tools
  only; write-effect tools additionally need `tools:write` (none in phase 2).
- The gateway keeps MCP 2026-07-28 only and answers other revisions with
  `-32022`, which keeps dual-revision clients on 2026-07-28.

### Traces

- All workflow runs write normal and private traces to
  `$PTC_ASSISTANT_DATA/ptc/traces` (a ptc project artifact root), on an
  encrypted disk.
- Rolling window: 30 days and 5 GB, whichever is hit first, enforced by a
  separate `ptc prune` run from cron (#2086). The artifact root is a ptc
  project root, and the gateway writes served runs into the same root (#2087),
  so the Viewer, REPL, and prune see every run.
- A trace cited by a report or issue gets a `keep/<run_ref>` marker and is
  kept past the window.

### Analysis

- Nightly: `ptc repl --profile private-run-analysis-v2 --private-unattended`
  over the last day's traces, producing `$PTC_ASSISTANT_DATA/reports/<date>.md`
  and, for ptc_runner defects, draft issues in
  `$PTC_ASSISTANT_DATA/reports/drafts/`.
- The analysis model reads private traces, which contain mail content, so the
  ZDR rule applies to it exactly as to workflows (OpenRouter account set to
  "ZDR endpoints only" enforces this for every call). Until a ZDR chat model is
  verified, the analysis reads normal traces only.
- **Nothing is filed automatically.** A draft becomes a public ptc_runner
  issue only after the owner reads it, confirms it is domain-blind and quotes
  no mail content, and files it (or tells an agent to). The draft's cited
  traces get `keep/` markers.
- Phase 3: a read-only analysis workflow served on the gateway behind its own
  scope, so run questions can be asked from claude.ai. The Viewer stays
  private.

### Models

- All model calls go through OpenRouter. Only providers with zero data
  retention may see mail bodies; record the chosen model and provider in each
  manifest.
- Decision backend: Jev (`typesafe/jev-*`), via the `decision/request`
  provider once promoted in ptc_runner. Research 2026-09-25: Typesafe does not
  train on inputs but states no retention period, offers ZDR publicly only to
  enterprise customers, and keeps a perpetual telemetry/abuse-monitoring
  licence; OpenRouter lists the Jev endpoint as ZDR (`retainsPrompts: false`)
  without a public Typesafe confirmation. The endpoint is alpha. Therefore:
  **metadata only** (sender, subject, label ids, header flags; no snippet),
  OpenRouter account set to
  "ZDR endpoints only", every request with
  `provider: {zdr: true, data_collection: "deny", allow_fallbacks: false}`,
  pinned `typesafe/jev-1.13`, OpenRouter input/output logging off.
- Chat backend: candidate `deepseek/deepseek-v4-flash`, usable for mail
  content only after a ZDR provider for it is verified on OpenRouter's ZDR
  endpoint list. Until then: the ledger stays regex-only, the analysis reads
  normal traces only, and no summaries are generated. Also the comparison
  backend for decisions.

## Security

- **Prompt injection:** mail is untrusted input. Workflows hold read-only
  grants only, so an instruction inside a message cannot send, delete, or
  browse. No send or modify tool is ever granted.
- **Secrets:** never in this repository. Env files and the Google refresh
  token stay on the box; Worker secrets stay in Cloudflare.
- **Filesystem:** no workflow holds a filesystem capability; state moves
  through `--input`/`--output`. The only readers of `$PTC_ASSISTANT_DATA` are
  the cron scripts and the analysis REPL (which reads the trace directory
  through its own profile). If a filesystem grant is ever added, it names a
  directory under `$PTC_ASSISTANT_DATA`, never the home directory (the box
  holds other projects' `.env` files and tokens).
- **Delivery:** no mail content leaves the box for notifications (see
  Delivery).
- **Public surface:** MCP only, OAuth-gated, owner-allowlisted.

## Phases

| Phase | Delivers | Exit criterion | ptc_runner change |
| --- | --- | --- | --- |
| 0 — probes | Desktop OAuth client and consent; `google-mcp` with `search_messages` and `list_events`; one `ptc run` manifest that calls both over stdio with trimmed results | The manifest returns today's events and 50 message headers through ptc | none |
| 1 — private | Build script; week 1 rules-only digest + predictions; week 2 oracle + category bootstrap; week 3 decision model on the residue; week 4 ledger and weekly rule proposals; `ptc prune`; nightly analysis; Viewer over Tailscale | Usefulness: two consecutive weeks reading the digest instead of Grok, clock starting week 1. Improvement: each kept layer beats the previous one in shadow mode; at least one reviewed ptc_runner issue from real traces | `ptc prune`; `decision/request` provider (by week 3) |
| 2 — public | One real claude.ai request logged through a throwaway tunnel (confirms 2026-07-28 and the OAuth discovery flow); Worker OAuth, tunnel, gateway serving `digest.today` and `ledger.query`; served-run traces | Digest read from claude.ai on the phone | served-run traces |
| 3 — code mode | A served tool that runs model-written PTC-Lisp, read-only over mail, calendar, and ledger; served analysis workflow | Owner uses it for ad-hoc questions weekly | code-mode surface (own issue and security review) |

## ptc_runner dependencies

To open in ptc_runner, described generically (single-operator remote
deployment), never mentioning mail:

1. #2086 `ptc prune PROJECT.json` — age and size window over a project's run
   artifacts, whole runs at a time, `keep/<run_ref>` markers exempt.
2. #2087 Served-run traces — an optional gateway `artifacts` section
   (`root`, `trace`, `inspection`) with the project artifact-root layout, for
   all tools; the operator's config authorizes it, never the endpoint.
   Private-policy templates stay refused. No per-caller identity: behind the
   Worker the gateway sees one bearer, so caller identity, if wanted, is the
   Worker's log, not the trace.
3. #2088 `decision/request` provider (chat backend: #2089) — promote the Jev decision lab
   (`scripts/labs/jev-decision/`) to a host-configurable provider with a
   vendor-neutral contract: state plus named boolean/choice/score questions in,
   per-question probability distributions out (probability may be `unknown`).
   Backends: Jev first, and a JSON-schema chat backend to keep the contract
   honest and serve as the comparison. Shares provider config, credentials,
   replay, cost budgets, admission, and trace/inspection records with
   `llm/request`. The provider never thresholds; workflows do.
4. (Phase 3) Code-mode served surface.

Related, not a dependency: #2091 (MCP OAuth issuer trailing-slash mismatch,
found while evaluating Google's official servers); #2090 (record the model and
provider that actually served each call).

## Open questions

1. Phase 2: how a *served* tool (`digest.today`, `ledger.query`) reads stored
   state, since a served call has no cron script to assemble `--input`.
   Candidate: the tool is served by a small read-only state tool in
   `google-mcp` or a sibling server.
2. (Resolved 2026-09-25) The official Google MCP preview needs a Workspace
   account; replaced by the own `google-mcp` server.
3. Workers VPC availability, versus a public tunnel hostname plus the bearer
   and an Access service token.
4. (Decided 2026-09-25) Delivery: tailnet-only page plus content-free ntfy.sh
   push; the owner's phone runs Tailscale. Self-hosted ntfy only if push
   content is ever wanted.
5. Whether a push is still wanted once `digest.today` exists (phase 2).
6. Written confirmation from Typesafe or OpenRouter that ZDR covers
   OpenRouter traffic — required before the snippet or any body goes to Jev.
7. (Decided 2026-09-25) Oracle window and bias: see Oracle.
8. (Decided 2026-09-25) Timezone Europe/Stockholm.

## Related prior work

- An earlier private prototype: a single-user Gmail LiveView client designed
  as the backing app for a ptc_runner mail assistant. Read for reusable
  Gmail/OAuth code and lessons.
- `ptc-web` — browser-content MCP server; possible future source for pages
  without an API.
- `ptc_manager` — separate repository on the same box; precedent for the
  deployment layout.

## Research (2026-09-24 and 2026-09-25)

- Google Workspace MCP servers: https://developers.google.com/workspace/guides/configure-mcp-servers
  (updated 2026-09-18); Gmail and Calendar release notes (preview announced
  2026-04-22). Revision support observed via unauthenticated `server/discover`.
- Google OAuth: https://developers.google.com/identity/protocols/oauth2 (7-day
  Testing expiry, invalidation causes);
  https://support.google.com/cloud/answer/13464323 (sole-user exemption).
  "No 7-day expiry for unverified production apps" is inferred from the docs'
  silence, not stated.
- claude.ai connectors: https://claude.com/docs/connectors/building/authentication;
  https://support.claude.com/en/articles/11175166 (egress `160.79.104.0/21`,
  plans, mobile). 2026-07-28 support on claude.ai is inferred from
  client-behaviour reports (medium-high confidence); Claude Code negotiates it
  by default since 2.1.274.
- MCP 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle
- Worker OAuth: https://github.com/cloudflare/workers-oauth-provider
- Workspace Developer Preview requires a Workspace account and per-project
  approval: https://developers.google.com/workspace/preview,
  https://developers.google.com/workspace/guides/configure-mcp-servers.
- Google refresh tokens: Desktop clients get them by default
  (https://developers.google.com/identity/protocols/oauth2/native-app); Web
  clients need `access_type=offline`
  (https://developers.google.com/identity/protocols/oauth2/web-server).
- Typesafe/OpenRouter data policy: https://typesafe.ai/legal/privacy-policy,
  https://docs.typesafe.ai/legal.md, https://openrouter.ai/api/v1/endpoints/zdr.
