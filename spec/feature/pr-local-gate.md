# PR local gate

## Purpose

GitHub-hosted Actions request a local, opposite-model review through a
Cloudflare Access-protected Tunnel. Cc workflow can also enqueue the same
review after ordinary CI succeeds for a session-authored PR. The review runtime
is the independent public Excubitor service `revisor`; Concordia does not host
the API or execute review jobs, so a Concordia PR remains reviewable while
Concordia is stopped.

## Concordia integration boundary

The independent service may read the original author context from Concordia's
`/v1/work/conversations` API. If Concordia is unavailable, it may open
`concordia.db` read-only and use the persisted session transcript. Notification
through `/v1/sessions/:id/inject` is best-effort and never changes the review
result.

Jobs, queue state, and temporary Anatomia PR reports are process-local to
Revisor and are not written to Concordia's database.

Cc resolves Revisor's loopback port from the live Excubitor catalog and never
hardcodes it. The enqueue integration is enabled when Cc workflow is enabled
and `CONCORDIA_REVISOR_TOKEN` is injected into the Concordia process. This
secret must equal Revisor's configured PR-gate origin token and must be supplied
through the local secret manager; it is never stored in Concordia's database or
logged. If Revisor or Cc is unavailable, the GitHub Action path remains
independent.

Cc does not enqueue drafts, fork PRs, PRs without successful ordinary CI, or
PRs that already expose the `Revisor review` Check for the current head. The
service also deduplicates concurrent Action/Cc submissions by repository, PR
number, and exact head SHA.

Before a Cc submission, Concordia reads the exact head commit message through
GitHub. `Revisor-Autofix: true` selects `verification`; failure to resolve the
message postpones submission instead of guessing `full`.

## Request lifecycle

For each exact PR head SHA the external service:

1. enqueues and deduplicates the request;
2. runs it in a bounded child-process worker pool;
3. resolves the local repository and validates its GitHub origin;
4. runs Anatomia's persistent initial project analysis when needed;
5. creates disposable detached head/base worktrees;
6. runs temporary Anatomia PR analysis;
7. runs Claude Opus for a Codex-authored PR, or Codex Sol for a
   Claude-authored PR;
8. lets the reviewer edit, but not execute repository code;
9. commits and pushes any autofix through the service-owned Git process;
10. reruns Anatomia for domain, orphan, architecture, and complexity checks;
11. requests a human domain decision when automatic spec/domain authoring
    remains insufficient.

## CI boundary

The local reviewer never runs PR code. Build, test, and lint remain in normal
GitHub CI. The workflow uses `pull_request`, read-only repository permissions,
and skips fork PRs before any secret-bearing step. It also requires repository
variable `PR_LOCAL_GATE_ENABLED=1`; dw sets this only after all required
Secrets have been provisioned.

Cloudflare setup, service configuration, worker count, and GitHub Secret
provisioning are documented in Castra's `spec/dw-pr-gate.md`.
