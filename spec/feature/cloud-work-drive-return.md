---
id: CC-CLOUD-DRIVE
title: Cloud work non-code outputs returned through Google Drive
status: draft
domain: cloud-execution
---

# Drive return for non-code outputs — 2026-11-02

Human instruction (2026-11-02, Discord thread "opus-5-5"): run Claude Code in the cloud kicked by Cc; code
returns by Git, everything else by Google Drive; Git keeps the existing Cloudflare receiver
(`concordia-cloud-git`). Synergos was rejected as a return route (its external transport itself depends on
Cloudflare Tunnel and UDP). Actio `actio:bc1c8eb1-84b0-47ba-ba9d-81cdf6bbcedc`.

Values: UX-CC-W2 (retain delegated work), W3 (distinguish result/review/release), W5 (recover after
interruption). Supporting domain `cloud-execution`. Revisor still owns review; Actio owns the task.

## Clauses

CC-CLOUD-DRIVE-01: a target may carry a `drive` binding (existing folder ID and the env names of an OAuth
client ID, client secret and refresh token). `transferMode: "drive"` returns every expected output through
Drive (S3 alternative). With `transferMode: "git"`, `driveExpectedNames` lists the non-code outputs returned
through Drive while `expectedNames` stay in the Git commit. A name may not be assigned to both. Per-run work
may supply `driveExpectedNames`; it is frozen in the intent with the rest of the plan.

CC-CLOUD-DRIVE-02: only Cc holds the Google credential. Cc exchanges the refresh token for short-lived access
tokens (no redirects, redacted failures) and opens one resumable upload session per expected file plus
`result.json`, named `<attemptId>-<name>` and tagged with appProperties `ccTarget`, `ccAttempt`, `ccName`. The
worker receives only those session URLs (single-file capabilities) and uploads `result.json` last. URLs are
never persisted in the journal or logs. Readiness requires all three secrets to be bound.

CC-CLOUD-DRIVE-03: collection lists the folder by those tags. Exactly one file per expected name is required;
a duplicate or stray tagged file is `cloud_drive_artifact_ambiguous` and is never guessed around. The manifest
is read first, then outputs under the total byte budget with timeouts and no redirects. Bytes are verified with
the existing manifest contract (CC-CLOUD-05) before the verified marker.

CC-CLOUD-DRIVE-04: in combined Git + Drive mode, Drive verification (side-effect free) runs before Git
promotion and review submission. A Drive failure never submits the Git result for review. The verified record
holds the Git review receipt plus the Drive artifact list; verified Drive bytes are downloadable as before.
Collection can be retried; it does not re-run the cloud job.

## Recovery and limits

Disable the target (or remove `drive`) to stop new Drive dispatch; journals and collected bytes remain.
Drive files are not deleted by Cc; retention is the folder owner's responsibility. Upload sessions expire on
Google's side (about one week); an expired session needs a new attempt after reconciliation, never a silent
resend. Service accounts have no My Drive quota: use an OAuth user credential, or a shared drive.

## Verification state

Unit tests cover configuration, token exchange, session creation, collection and ordering with mocked HTTP.
No live Drive folder, credential or cloud run has been configured or exercised. The Tokyo2070 trial remains the
live acceptance; mocks do not replace it.
