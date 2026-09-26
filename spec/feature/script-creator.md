---
title: Cc-owned script creator and shared command execution
id: CC-SCRIPT-CREATOR
status: draft
service: concordia
domain: tooling
---

# Purpose and ownership
UX-CC-W1/W3/W5 and UX-CC-S1/S4/S3: users must retain the ability to identify a command's target, declared effects, verified version and actual outcome. Cc owns the definition format, creator, verification and execution lifecycle. The target repository owns its versioned script definitions. The existing harness owns execution authorization; neither manifests nor verification receipts grant permissions.

The common entry is command-runner, with script:create/inspect/verify/run/list operations. New scripts are data registrations, not new per-script privileged command handlers. Existing named built-ins remain compatible. A skill routes requests such as ツール作成, スクリプトにして and コマンドにして into this workflow.

# Contracts
- CC-SCRIPT-01: Create takes UTF-8 JSON containing a Node module, Node test module, description, named string arguments and required permission labels. It writes tools/generated-scripts/<id> atomically, never executes it, treats an identical retry as unchanged and rejects conflicting definitions. IDs and paths are constrained. Registry and script files must not traverse symlinks outside the chosen repository.
- CC-SCRIPT-02: Inspect returns the definition and content digest. Verify explicitly executes the supplied Node tests in a bounded child process. A successful receipt binds the manifest, script and test bytes. Any change or failed verification invalidates it. Tests are code and require the same user/tool authorization as execution; a green receipt is not a security approval.
- CC-SCRIPT-03: Run requires the inspected digest, a matching successful test receipt, valid arguments and an explicit caller run ID. Persist started before the external effect, then persist the observed result. A repeated run ID returns the saved result, or result-unknown after interruption, without executing twice. Different input under an existing ID is rejected. No automatic retry follows timeout or uncertain outcome. The caller reconciles external state before deliberately using a new run ID.
- CC-SCRIPT-04: No shell evaluation, executable override or blanket permission grant. The actual runner invocation remains subject to the harness and sandbox. Permission labels disclose expected effects, not a sandbox. Node scripts are reviewed trusted local code; this is not an untrusted-code hosting service. Timeout/output bounds apply, and cancellation terminates the owned child process tree.

# Storage and recovery
Definitions use manifest.json, script.mjs, script.test.mjs, verification.json and runs/<run-id>.json. Verification and execution lock the same definition to avoid overlapping operations. A leftover lock fails closed and must be inspected before manual removal; time passing never proves the owner dead. Files are bounded regular files; an unexpected link or file is rejected. Results distinguish success, failed and unknown. Process crash after starting can leave a started receipt, which is reported unknown without replay. Lost output does not mean the command did not run. Secrets and session IDs must not be written into definitions or CLI arguments.

# Boundaries and validation
Pure contract validation is separate from filesystem and process adapters; application orchestration composes them. Test creation idempotency/conflicts, path traversal and links, invalid/missing arguments, content changes after verification, failed tests, timeout, repeated execution IDs and interrupted runs. The first version supports Node scripts and Node built-in tests only. Actual service startup, deployment and external publication remain in their authorized existing workflows.

Rollback: remove the generic adapter from command-runner and stop invoking new scripts; retain definitions and receipts for reconciliation. Do not delete unresolved run records. This change does not migrate existing service-control/commit/review handlers or claim completion of the separate developer-toolset worktree.

## Cc script creator contract validation
`tools/command-tools/contract.mjs` validates CC-SCRIPT-01 and CC-SCRIPT-04: IDs, declaration fields, arguments and exact inspected digest.

## Cc script creator storage and recovery
`tools/command-tools/storage.mjs` owns CC-SCRIPT-01 and CC-SCRIPT-03: bounded regular files, non-link directories, atomic publication, identical creation retries, exclusive operation locks, and flushed execution receipts. A failed publication leaves an explicitly reconcilable staging artifact, never a successful definition.

## Cc script creator bounded process execution
`tools/command-tools/process.mjs` owns CC-SCRIPT-04: Node-only argument arrays, bounded output and runtime, UTF-8 streaming, cancellation and termination of the owned process tree. Scripts must await and clean up their own children; detached grandchildren that outlive a Windows parent cannot be guaranteed recoverable by taskkill and are outside the supported script contract.

## Cc script creator lifecycle
`tools/command-tools/service.mjs` composes CC-SCRIPT-02/03: invalidate before verification, recheck digest afterwards, persist started before effects, preserve known results and unknown interrupted runs without replay.

## Cc script creator command routing
`tools/command-tools/cli.mjs` implements CC-SCRIPT-04: strict operation/options, UTF-8 request files, structured output and failing exit status for failed/unknown results. The shell execution gate remains the authorization owner.
