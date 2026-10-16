---
title: "Implementation tool fast paths"
status: implemented
service: concordia
domain: session-coordination
updated: 2026-08-06
---

# Implementation tool fast paths

実装作業で繰り返す既存操作を、一回のtool requestへまとめる。単一セッションが複数実装を
並行して扱えるよう、session-levelのworkflow stageや新しい状態機械は持たない。

## State owners

- project/task/repo/branch binding: 既存 `sessions` 行
- service traffic: 既存 `service_test_claims`
- review: Revisor local PR
- notification: Revisorのsession inject

## API

| Method | Path | Body | Effect |
|---|---|---|---|
| POST | `/v1/implementation-tools/bind` | `{session_id,cwd,task}` | gitを一度検査し、repo/origin/branch/project codeを解決してsession bindingを更新。 |
| POST | `/v1/implementation-tools/worktree` | `{session_id,project_code,branch,task}` | Actio登録を照合し、main起点のworktree・ignored情報・session bindingを一要求で準備する。詳細は[worktree契約](implementation-worktree.md)。 |
| POST | `/v1/implementation-tools/service` | `{session_id,service_code,action,note?}` | testing claim、Excubitor control、releaseを一要求で実行。 |
| POST | `/v1/implementation-tools/review` | `{session_id}` | local PRを提出。既存PRがfailed/action_requiredならretry。 |

## Efficiency rules

## Binding consistency and failure contract (CC-BIND-01–04)

UX-CC-W1/W5, CC-INV-01/04: a user must not submit from a stale repository after
only the task label changed. This supporting boundary is project-code-registry;
session rows/metadata/events remain owned by SessionsRepo.

- CC-BIND-01: resolve the canonical main checkout from Git metadata and match its
  registered path exactly. Display-name/leaf-prefix heuristics must not choose a
  repository for an explicit bind. Git failures are not an absent origin.
- CC-BIND-02: commit task, repo/origin/branch/project, explicit metadata and the
  binding event in one short transaction. Refuse a stale or inactive session
  snapshot after asynchronous inspection; a failed transaction changes nothing.
- CC-BIND-03: failures retain `error=implementation_bind_failed` and add safe
  `reason`, `stage`, `binding=unchanged`, and `guidance`. No raw exception, path,
  token, or Git stderr is returned. Unknown failures stay explicit.
- CC-BIND-04: post-commit notification failures do not turn a committed binding
  into a failed bind. Return success with `notification=deferred` and log the
  safe stage; inspect session state before any retry after response loss.

Recovery: correct the named prerequisite, reread the current binding, then retry
the same intended checkout. No automatic switch/reset, Actio restart, or new
worktree is used to mask a failure. A lost HTTP response is still result-unknown.
No DB migration. Regression coverage includes rollback, stale snapshots, unknown
project paths, Git failures and post-commit notification failures.

CC-BIND-05: startup policy selection must not mistake a workspace-level `.wt-*`
directory for the workspace repository. A canonical checkout match remains first;
when only the broad workspace guess matches, use the registered origin or explicit
target. This does not authorize a different Git checkout or bypass a branch guard.
The policy projection owns this selection; SessionsRepo still owns binding state.

Review follow-up: the agent-delegation run failed in the worktree integration test
with `invalid main repository`. This suite shares a Vitest worker; identity adapters
mocked by service tests must be restored before importing the real integration
path. Tests now reset cached modules and unmock those two adapters at collection.
Session test execution remains unperformed; Revisor must verify the corrected run.

- project code表をLictorやagentへ複製せず、Ccのresolverをworkspace設定単位でcacheする。
- bind は設定済み workspace 内の実パスだけを受け付け、応答・event に absolute path / origin を複製しない。
- bindは`repo_path/current_task`を最新対象へ更新し、`active_repos`は上書きせず追加する。
- git root取得後のbranch/origin照会を並列化する。
- session idはLictor sidecarが付与し、利用者は取得しない。
- Cc/Ex/Rv endpointは既存clientが解決する。
- Exの事前detail GETは行わず、control API自身のcatalog検証へ一本化する。
- service claim競合時はcontrolせず、そのrequestのclaimを即releaseする。
- controlは成功・失敗を問わずfinallyでreleaseする。
- review statusのpollingやsession-level stageを追加しない。
- 通常の会話・調査セッションには自動介入しない。
