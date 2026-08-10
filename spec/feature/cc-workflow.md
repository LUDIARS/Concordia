---
title: "Cc workflow injection"
status: implemented
service: concordia
domain: session-coordination
updated: 2026-07-06
---

# Cc workflow injection

Concordia injects a startup workflow packet into each registered agent session.
The packet is returned as `context_packet.cc_workflow` from `POST /v1/sessions`
and `GET /v1/sessions/:id/context`, then printed by `tools/concordia-hook.mjs`
as `[concordia/cc-workflow]`.

The workflow requires agents to:

- break work into todos and submit `task_update` through the Concordia API;
- create or switch to a task branch before editing;
- push the branch and open a PR after implementation;
- append user interruptions after the current queue unless explicitly marked as priority;
- stop after the PR is created; tests, CI-fix continuation, merge, auto-merge, and main updates require an explicit user instruction.

これらの要求はすべて Cc と Revisor が生きていることを前提にしている。前提が崩れて復旧作業
自体が始められない場合に備えた [エスカレーションモード](escalation-mode.md) は定義済みだが、
現時点では未実装であり、この packet はまだ差し替わらない。実装後は task 登録と worktree 要求を
外し、本ブランチの直接操作を許し、他セッションへ作業停止 claim を送る。外れる範囲と、外した
ことを記録に残す条件はリンク先が定義する。

PR CI follow-up is also backed by the existing PR reconciler. When GitHub status
changes to `success` or `failure` for a session-authored PR, Concordia enqueues
a `pr-ci-followup` pending task for the author session. The hook prints that task
on the next prompt/heartbeat/session-end pull as a status report; it does not
authorize tests, CI fixes, or merge work by itself.

When Cc workflow is enabled and `CONCORDIA_REVISOR_TOKEN` is configured, the
same reconciler asks the independent Revisor service to review a
session-authored, non-fork PR after ordinary CI succeeds. Cc resolves Revisor
through Excubitor and does not execute review code itself. An existing
`Revisor review` Check suppresses repeat requests; Revisor also deduplicates
Action/Cc races for the same exact head SHA.

Cc reads the exact head commit message before enqueueing. A
`Revisor-Autofix: true` trailer selects verification-only mode so an autofix
does not recursively start another full review.
