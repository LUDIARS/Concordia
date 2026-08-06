# Test Forum session started inside the target repository

- Date: 2026-08-06
- Status: fixed in working tree
- Area: Discord Test Forum / session spawn
- Severity: Test verification can inspect the wrong surface and fail before reading the forum request

## Summary

This is a regression in the Test Forum launch contract. Verification sessions were started with the repository directory as `cwd` and with branch/worktree spawn arguments. In the reported case the session tried local Revisor/Concordia access, then fell back to GitHub and reported a 404 instead of reading the TestWorkflow forum post and inspecting the intended local PR.

## Evidence

On 2026-08-06 the user reported a Test Forum response for Concordia #247 stating that local Revisor/Concordia could not be reached because of a sandbox failure and that GitHub returned 404. The affected request is built by `requestTestSpawn` in `src/discord/test-forum-actions.ts`; automatic Test QA used a repository `cwd` in `src/discord/test-forum-qa.ts`.

## Regression Context

Test Forum sessions need broad read access from the configured workspace root. Starting them under `E:/Document/Ars/Concordia` or another individual repository narrows their initial context and makes the agent infer the wrong review route.

## Cause

The spawn request used `surface.repo_root_path` as `cwd` and asked the generic session spawner to create a branch worktree. The target directory and branch were encoded as spawn mechanics instead of being supplied to the already-running verification session as instructions.

## Fix Requirements

- Start every Test Forum verification and Test QA session from the configured workspace root (for this installation, `E:/Document/Ars`).
- Do not pass the target branch/worktree as generic spawn mechanics.
- Include the repository/worktree target, branch, and requirement to read the forum post in the initial prompt.

## Verification

Regression tests must assert that the spawn `cwd` is the workspace root, `branch` and `worktree` are absent, and the prompt contains the target directory and branch. Tests were added but not run because the session policy forbids test execution without an explicit request.

## Follow-up

After deployment, start one Test Forum session and confirm its initial cwd is the workspace root and its first response references the forum content and target local directory.
