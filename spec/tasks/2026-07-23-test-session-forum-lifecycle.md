# Test and Session Forum startup synchronization

## Goal

Make Cc synchronize the Test Forum and Session Forum independently at Cc startup,
and align TaskWorkflow lifecycle behavior with open pull requests, worktrees, and
session completion.

## Terminology

- **Session Forum**: the existing Forum whose threads represent Cc sessions.
- **Test Forum**: a dedicated Forum whose threads represent testable open
  PR/worktree states. Do not overload TaskWorkflow confirmation threads for this.
- **PR updated**: the open PR's head commit SHA changed after a Test Forum surface
  was created. The old surface describes an obsolete test candidate and must close.

## Required behavior

### Startup synchronization

At Cc startup, schedule two explicit, idempotent reconciliations:

1. Session Forum synchronization.
2. Test Forum synchronization.

They may share the existing configurable boot delay, but one failure must not
prevent the other from running or being reported.

### Session Forum

- Active sessions retain/open their current surface.
- Ended sessions close/archive their Forum thread.
- Lost sessions also close/archive their Forum thread.
- Reconciliation at startup repairs stale open threads left by an earlier process
  exit.

### Test Forum and PR/worktree linkage

- Add/configure a dedicated Test Forum and the minimum persistent linkage needed to
  reconcile its surfaces.
- A current test candidate is linked to an open/draft PR and its head SHA, plus a
  matching worktree when one exists.
- Startup reconciliation creates or keeps one open Test thread for each current
  candidate.
- Close/archive a Test thread when:
  - its linked PR is merged or closed;
  - its linked PR head SHA changes;
  - its linked worktree is removed;
  - the candidate is otherwise no longer current.
- A changed open PR may receive a new current Test thread after the obsolete one is
  closed.
- Persist GitHub head SHA if the existing PR record is insufficient. Keep schema
  migration and repository access focused.

### TaskWorkflow

- A user-confirmation request must actually mention the configured Discord user.
  Set an explicit allowed-mentions user list; literal `<@id>` text alone is not
  sufficient.
- When an autonomous TaskWorkflow run finishes with no residual task, next task,
  decomposition, or pending human decision, emit the existing provider-aware
  session-end injection exactly once (`/session-end` for Claude,
  `$session-end` for Codex).
- Do not auto-end while useful autonomous or human-gated work remains.

## Design constraints

- Put Test Forum reconciliation and persistence in focused modules; do not grow
  `discord/bot.ts` or TaskWorkflow runtime into catch-all classes.
- Treat GitHub/DB/repo scans as adapters behind reconciliation logic that can be
  unit tested without live services.
- Update Discord configuration/cache and relevant specifications.
- Startup is the source-of-truth reconciliation point; event-driven refresh is
  optional and must not replace startup reconciliation.

## Acceptance

- Unit tests cover independent boot reconciliation and failure isolation.
- Unit tests cover ended/lost Session thread archival.
- Unit tests cover open, merged/closed, head-updated, and missing-worktree Test
  candidates.
- Unit tests prove the confirmation message has explicit mention permission.
- Unit tests prove session-end is injected exactly once only after true autonomous
  completion.
- Type checking passes.
