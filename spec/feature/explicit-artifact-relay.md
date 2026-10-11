---
title: Explicit artifact delivery under final-only output
type: feature
id: CC-EXPLICIT-ARTIFACT-01
service: concordia
domain: chat-platforms
status: draft
---

# Explicit artifact delivery under final-only output

## Value and authorization

UX-CC-W3/W4: a person who requests an artifact must receive the file even when
their department hides intermediate conversation. Human scope authorization is
the 2026-10-11 response 「修正して投稿まで続行（推奨）」 to the artifact-delivery repair proposal.
This does not authorize tests or service restarts. Actio task-links was empty;
the scoped tasks_list request returned 409 operation_failed. Task status remains
unknown; this document is a contract, not a replacement task-status record.

## Ownership and invariants

The supporting `chat-platforms` domain owns the Discord relay decision. Lictor
owns stamping the caller's session and explicit destination on send-file posts.
Department settings retain their existing owner and are never modified here.

- CC-EXPLICIT-ARTIFACT-01: under intermediate=off, allow only a `system` chat
  post with a session, an explicit Discord destination equal to that session's
  registered channel, and at least one attachment accepted by the existing
  attachment loader. Deliver its caption with the files.
- CC-INV-02: preserve session/surface liveness and destination checks. Meta
  posts, another session's channel, and a ready private channel different from
  the session surface do not qualify. Discord ingress remains non-relayable.
- CC-INV-04/06: HTTP acceptance and Discord delivery are different facts. Only
  a successful webhook response records the Discord message mapping.
- Empty, missing, rejected or oversized attachments must not turn hidden chat
  into a caption-only post. Ordinary chat and canonical final-answer policy
  are unchanged. No new source flag or department setting is introduced.

## Delivery and recovery

Check the post envelope before reading files; reevaluate policy with the actual
accepted attachment count before obtaining a webhook. An artifact exception is
limited to an active session and active registered Discord surface, including
after asynchronous file loading; it does not use the teardown grace window.
No old messages are replayed by this change. Reconcile a known chat ID with its
delivery mapping before retrying. A missing map alone is not proof that an
uncertain external send failed. The model delivery being repaired was confirmed
suppressed before webhook invocation by the previous policy.

## Acceptance and rollout

Pure policy and egress regression cases cover successful own-surface delivery,
normal intermediate suppression, wrong/missing destinations, meta/private
destinations, empty/all-rejected attachments, ingress and inactive sessions.
Tests are added but not run without human execution permission. Submit through
Revisor. Runtime reflection requires the normal authorized service workflow;
do not start the application from a worktree or copy unreviewed files to runtime.

Investigation: Anatomia plan --no-llm identified the existing chat-platforms
boundary; it reported unavailable project-name links and skipped unrelated
invalid definitions. Praeforma's registered Concordia project endpoint responded
200. Repository specs and source are the implementation evidence, not live QA.
