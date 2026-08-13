# Revisor #532 reused a merged implementation branch

- Date: 2026-08-13
- Status: fixed in working tree
- Area: Revisor local PR submission / worktree lifecycle
- Severity: review blocked by conflicts in nine unrelated implementation files

## Summary

This was a workflow regression. After Concordia #516 had been merged into `main`, a follow-up
task document was committed on the already-merged `feat/goalgo-improvements-impl` branch and
submitted as Concordia #532. Revisor compared the reused branch with the current `main` and
reported conflicts in nine implementation files that were unrelated to the new task document.

## Evidence

- Concordia #516 merged as `8c97ac32f355`.
- The follow-up task document was committed as `8f7baa6c` on
  `feat/goalgo-improvements-impl` instead of a new branch based on the merged local `main`.
- Revisor later advanced that branch to automated-fix commit `05f6bfd1`.
- Concordia #532 reported conflicts in the contract, vibes lifecycle, ask-detach, and prior
  problem-log files even though the intended new content was only one file under `spec/tasks/`.

## Regression Context

The worktree had correctly been retained until #516 reached a terminal result, but it was then
reused for a new logical task. A merged branch is no longer a valid base for follow-up work when
Revisor has produced the canonical merge commit on `main`.

## Cause

The follow-up task was treated as a continuation of the old branch rather than as a new task.
Its history retained the pre-merge implementation commits and subsequent Revisor autofix
commits, so the next local PR reintroduced historical differences against `main`.

## Fix Requirements

- Create a new task-specific worktree and branch from the local `main` after a PR is merged.
- Carry only the new task document onto the replacement branch.
- Do not merge, rebase, reset, or otherwise rewrite the conflicted branch from this session.
- Submit the replacement branch as a new Revisor local PR and treat #532 as superseded.

## Verification

- Confirm the replacement branch starts at `8c97ac32f355`.
- Confirm `git diff main...HEAD` contains only the new task document and this incident log.
- No unit, integration, startup, or runtime test is required for this documentation-only fix.

## Follow-up

After the replacement PR reaches a terminal merged result, remove both retained worktrees using
the normal non-force worktree cleanup path.
