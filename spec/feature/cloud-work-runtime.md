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
