# Castra root overwrites the working-project session binding

- Date: 2026-08-07
- Status: fixed in working tree
- Area: session registration and Lictor task synchronization
- Severity: high — worktree sessions cannot be safely submitted for review

## Summary

Regression: a session launched from the Castra workspace root can resolve a child
project such as Concordia, yet Cc continues to regard Castra as the session's
working repository.  An automatic task update then overwrites the explicit
worktree branch claim with Castra's `main` branch.

## Evidence

- A root-started session resolved a Concordia child project, then received
  `lictor.task.changed` with `source=auto` and `branch=main`.
- Its Cc record subsequently reported the workspace root with `repo_origin=null`
  and `branch=main`, rather than the child-project task worktree and its
  explicit working branch.
- `src/api/sessions/lifecycle.ts` explicitly permits a workspace-root cwd to
  remain the registered session repository.

## Regression Context

Cc already excludes workspace roots from conflict grouping, but does not apply
the same distinction when it maintains the session's working-project binding.
The resulting state conflicts with the Cc work policy, which requires the
actual edit worktree, origin, and branch to be registered before implementation.

## Cause

The leading cause is that a Castra root registration is treated as a normal
repository binding.  Later automatic Lictor updates therefore use the root's
`main` branch even after Cc has inferred a child `target_project` from an
explicit task claim.

## Fix Requirements

- Treat a configured workspace root as an umbrella, never as a working-project
  binding for a child-project task.
- Preserve an explicit child-project branch claim against subsequent automatic
  root-derived updates.
- Keep cross-repository investigation from the root available without treating
  it as an implementation checkout.

## Verification

- Add focused regression coverage for a root-started session that claims a
  child project and then receives a root-derived automatic update.
- Confirm the resulting session binding keeps the child project and explicit
  branch.  Tests were not run in this session by user instruction.

## Follow-up

Existing active sessions may retain stale root bindings until they register a
project claim again after the fix is deployed.
