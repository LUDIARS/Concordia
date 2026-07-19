# Session workflow recurring regressions (2026-07-19)

## Report

neco reported five Concordia regressions:

1. Forum posts must use webhooks so the displayed name and avatar can be changed.
2. Discord command `/cc-skill` must invoke a skill from the Session's current working branch.
3. The workspace root (Castra; `E:\Document\Ars` in the reported environment) must never be a Session working directory.
4. A requested working branch must be confirmed and registered in Cc.
5. A Session must stop at commit + PR by default. It must not run tests or merge automatically unless the user explicitly instructs it to do so.

Items 3-5 have been instructed repeatedly. This repair therefore follows the three-out rule: replace the failing structure with central invariants instead of adding another reminder to one prompt.

## Evidence and root causes

### Forum webhook identity

- Ordinary Forum thread traffic already goes through `WebhookPool` and supports per-message `username` and `avatar_url`.
- `createForumSessionThread` bypasses that path and calls `forum.threads.create({ message: ... })`, so the starter is authored by the Bot and cannot use a per-post webhook identity.
- Chat/session relay types discard webhook identity metadata before egress, so callers cannot configure an avatar even though `WebhookPool` can send one.

### `/cc-skill`

- `spec/feature/discord-ui-pr-b.md` describes a skill command, but no command module or Session skill proxy exists.
- Lictor exposes a per-Session `/v1/skill` sidecar API. Concordia already knows each Session's `repo_path`, but no code resolves skill sources from that exact worktree.

### Workspace-root cwd

- `loadConfig` derives `spawnDefaultCwd` from `LUDIARS_ROOT`.
- `/v1/spawn` and `/v1/admin/spawn-session` fall back to `AdminState.getWorkspaceRoot()`.
- `resolveAgentHomeCwd` and `resolveCastraDefaultCwd` preserve that fallback.
- Consequently, the launcher itself selects Castra as cwd. An injected instruction cannot prevent a Session from already having been started in the forbidden directory.

### Requested branch registration

- `prepareSpawnTarget` resolves or creates the requested branch/worktree correctly.
- `PendingDelegationSpawn` does not retain the resolved branch.
- Some admin spawn paths record pending spawn metadata only after `spawnSession`, which races a fast Session registration.
- Session registration therefore depends only on the child hook's branch observation and cannot audit the requested branch or recover it when the hook reports no branch.

### Session completion policy

Conflicting defaults are spread across multiple sources:

- `collaboration-context.ts` tells Sessions to monitor CI, request tests, and merge.
- `persona-context.ts` explicitly permits unit tests.
- `inject-manual-seed.ts` says review and tests may run after PR creation.
- `error-fix.ts` instructs automatic squash merge.
- delegation seed templates require tests, and PR reconciliation tells Sessions
  to continue into tests, CI repair, and merge after the PR exists.
- harness wording blocks only service/behavior tests rather than all unrequested tests.

Several scheduled delegation templates also use `E:\Document\Ars` directly as
their `default_cwd`, bypassing project selection before the Session starts.

No single Session default is authoritative, so fixing one prompt leaves other paths able to reintroduce the behavior.

## Corrective design

1. Create Forum starters through the parent Forum webhook and retain the webhook message/thread identifiers. Carry configurable webhook name/avatar metadata through read models and egress.
2. Add `/cc-skill` with autocomplete. Resolve skill files only beneath the target Session's registered `repo_path`, report its registered branch, and proxy the selected content to that Session's Lictor sidecar.
3. Add a central spawn guard that rejects missing cwd and every configured workspace root. Forum intake must ask for a project when project resolution fails. Remove workspace-root cwd fallbacks from public spawn paths.
4. Persist the resolved requested branch in the pending-spawn registry before launching the child. Correlate it with SessionStart by a unique spawn ID (cwd is legacy fallback only), compare requested and observed branches, register the resolved branch in Cc, and surface a mismatch instead of silently continuing.
5. Define one Session default policy: identify project, confirm/register branch, commit + push + PR, then stop. Tests and every form of merge require an explicit user instruction. Align delegation manuals, collaboration context, harness defaults, and error-fix prompts with it.

## Regression coverage (not executed in this Session)

Per the reported policy, this change adds or updates automated test code but does not execute tests. Coverage should include:

- webhook-created Forum starter returns both message and thread IDs and applies name/avatar;
- `/cc-skill` lists and reads only the Session worktree's skills and rejects traversal;
- all spawn paths reject workspace-root or omitted cwd;
- pending branch is recorded before spawn, registered on Session start, and mismatch is surfaced;
- every default Session policy ends at PR and forbids unrequested tests/merge.
