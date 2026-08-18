# Revisor merge conflict for Discord task-body posting

- Date: 2026-08-18
- Status: resolved in feature worktree; awaiting Revisor review
- Area: Discord session task posting
- Severity: merge-blocking

## Summary

Revisor local PR #653 cannot merge because `src/discord/bot.ts` was changed on both the feature branch and
the current `main` branch.

## Evidence

Revisor reported: `The head conflicts with the current 'main' in 1 file(s): "src/discord/bot.ts"`.

## Cause

The current main branch added team-card posting after the branch split. The PR independently improved
session task posting by serializing posts for each session and rereading relay state immediately before post.

## Fix Requirements

- Preserve main's team-card posting.
- Preserve the PR's serialized session task posting and fresh relay-state reads.
- Re-run the Revisor review after integrating main into the feature branch.

## Verification

No local tests are run without an explicit test instruction. Revisor's registered checks must pass on the
integrated branch before the approved merge is retried.
