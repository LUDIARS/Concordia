---
id: CC-CLOUD-RUNTIME
title: Standard hosted cloud delegation runtime
status: draft
domain: cloud-execution
---

# Runtime integration

The authorized implementation extends `/v1/delegation/cloud`, mounted by the
existing core API composition. It does not introduce another scheduler or convert
remote sessions into local Lictor children. Actio remains the task owner.

The existing loopback/admin trust boundary applies. Every operation resolves an
active parent session, its canonical repository and subsidiary, and checks the
Actio task in that scope. Journal directories are separated by that scope. Request
bodies cannot choose a filesystem path, provider executable, token or storage host.
Submission also checks the existing daily/monthly budget gate, company session
capacity and pending human-question gate. Remote consumption and cancellation are
not inferred from local session accounting; provider-side usage limits still apply.

Configuration is an operator-owned JSON file selected by
`CONCORDIA_CLOUD_CONFIG_FILE`. It contains standard hosted target identities,
published branch/revision, environment preparation evidence and secret variable
names only. Missing configuration is an explicit unavailable response. Secrets
come from existing service environment bindings, never an API response.

For the first transport implementation, support an already configured private AWS
S3 bucket. This is a code capability, not authorization to create a bucket, buy
storage, expose a service or change access policy. Each attempt has separate keys.
Signed PUT URLs expire and require `If-None-Match: *`; only those object URLs go to
the worker, never the underlying account credentials. Do not persist these URLs in
the local journal or ordinary logs. Codex receives the prompt on stdin, not argv.
The result manifest is written last. GET URLs are generated locally only when
collecting. Downloads have byte limits, timeouts and no redirects. Verify all bytes
before saving a verified marker or serving a downloadable artifact.

The UI offers configured targets, a linked task and instruction, submission,
status lookup, artifact collection and downloads. A lost response retains the
attempt ID; clicking again cannot create another attempt. A separate explicit
reconciliation operation records an observed provider ID without a resend.
Submitted, unknown and artifacts-verified remain separate from task acceptance,
review, release and actual remote cancellation. No automatic Actio completion.

Configuration and storage selection remain unanswered human setup inputs. The
Tokyo2070 trial is the live acceptance; mocks or local generation cannot replace it.
Candidate projects also include Synergos and heavy rendering in Fg/LD, subject to
all four admission conditions. Restore by disabling the cloud configuration while
preserving the journal and collected outputs; never remove intents to retry.

## Claude CLI launch — 2026-11-03

Human instruction (Discord thread "opus-5-5"): add `claude --cloud`, then "CLIで統一" — the routine fire
adapter is replaced. Actio `actio:58f293ad-f2cf-4934-8b29-287a1dbde77b`.

CC-CLOUD-CLAUDE-CLI: Claude targets set `claudeExecutable` (native binary). Preflight requires the target's
checkout to be on `publishedBranch` at `sourceRevision`, because `claude --cloud` clones that branch from the
remote. Transfer capabilities (Git/Drive) are prepared first; a preparation failure launches nothing. Cc then
runs `claude --cloud <packet>` shell-free; the packet holds public task data only. Exactly one distinct
`session_`/`cse_` ID in its output is accepted, else `submission_unknown`. Private transfer instructions are
queued as one message with `claude -p --cloud <id> --output-format json` on stdin; only `{ok:true, session_id}`
matching the created ID counts as submitted. A created session whose transfer message is unconfirmed is
reported unknown for operator reconciliation; nothing is resent. The child environment drops API-key and
third-party provider variables so the claude.ai login is used. The CLI's creation output format is not
documented as a stable machine contract; the first live run must confirm the parser before relying on it.

## Claude routine creation with CLI follow-up — 2026-11-03

Live check (2026-11-03): `claude --cloud "<task>"` refuses to create a session without an interactive terminal
("--cloud requires an interactive terminal"), so CC-CLOUD-CLAUDE-CLI cannot run from the Cc service. Human
choice: create by routine, send follow-ups by CLI. Actio `actio:9f4dcd97-225f-4fa2-9f4a-e07c35441e97`.
This supersedes the creation half of CC-CLOUD-CLAUDE-CLI.

CC-CLOUD-CLAUDE-HYBRID: Claude targets set `claudeTriggerId` (`trig_...`), `claudeTokenEnv` and
`claudeExecutable` (native binary). Readiness requires the bound fire token. Transfer capabilities are prepared
first; a preparation failure fires nothing. Cc fires the routine with the public packet only; a reply with
`type: "routine_fire"` and a valid `claude_code_session_id` identifies the session, anything else is
`submission_unknown`. Private transfer instructions are then queued as one ordinary user message with
`claude -p --cloud <id> --output-format json` on stdin; only `{ok:true, session_id}` matching the ID counts as
submitted, otherwise unknown for operator reconciliation. Nothing is resent. The routine clones its own
configured repository, so the local checkout is not inspected; the published-revision check still applies.
The routine's saved prompt should tell Claude to treat the `routine-fire-payload` as its work packet and to
wait for the follow-up message before any upload or push.
