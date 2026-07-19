# Worktree startup trust configuration missing

- Date: 2026-07-19
- Status: fixed in working tree
- Area: Session spawn / worktree preparation
- Severity: startup blocked by an interactive dialog

## Summary

neco reported that a Session started inside a project worktree can show an initial
trust/configuration dialog, then requested project-specific Skill and Memory
placement. Project-local `.claude`, `.agent(s)`, MCP JSON, Skill, and the primary
project's Memory must be available before the provider starts.

## Evidence

- `src/control/spawn-target.ts` creates a linked Git worktree and immediately
  returns it as the Lictor cwd.
- Git only materializes tracked files. In the reported Concordia project,
  `.claude/` is ignored and contains `settings.local.json` and local skills, so
  the generated worktree does not contain them.
- `spec/setup/hooks-codex-cli.md` documents that untrusted project hooks cause a
  first-run trust review.
- Lictor reads Memory from `~/.claude/projects/<absolute cwd key>/memory`. A
  linked worktree has a different absolute cwd key, so it cannot see the primary
  project's already-organized Memory unless Cc places it under the worktree key.

## Regression Context

Branch/worktree selection was added to Cc, but its preparation boundary handled
Git state only. It did not prepare the provider's ignored project-local startup
configuration before launching Lictor.

## Cause

`prepareSpawnTarget` created or reused the target worktree without copying ignored
agent configuration from the source project root.

## Fix Requirements

- Copy missing `.claude`, `.agent`, `.agents`, `.codex`, `.mcp.json`, `mcp.json`,
  and `mcp_servers.json` content before Lictor starts.
- Treat project-local Skill directories as the Skill source; do not distribute
  workspace-global or another project's Skill into the worktree.
- Copy only the primary project's Markdown Memory from its Claude project key to
  the corresponding worktree key. Never write private Memory into the Git repo.
- Preserve configuration already present in the target worktree.
- Do not copy runtime state, worktree registries, session logs, caches, or symlinks.
- Fail the spawn preparation visibly if a required copy fails.
- Remove a newly created worktree/branch if preparation fails after `git worktree add`.

## Verification

Regression test code covers copied trust/Skill/MCP files, project-keyed Memory,
excluded runtime state/non-Markdown files, and preservation of worktree-local
configuration and Memory. Per the Session instruction, the tests are added but
not executed in this Session.

## Follow-up

No service restart or live startup verification is performed in this Session.
