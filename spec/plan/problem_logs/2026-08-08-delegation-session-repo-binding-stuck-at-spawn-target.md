# Delegation-spawned session keeps its spawn-time repo_path/branch after an explicit later project claim

- Date: 2026-08-08
- Status: workaround found
- Area: session registration (`sessions.repo_path` / `repo_origin` / `branch`) and `lictor cli task set`
- Severity: High — blocks `POST /v1/prs/local` for any delegation session that later switches project

## Summary

Related to [[2026-08-07-castra-root-session-binding]] but distinct trigger: that log covers a
**root-cwd** session defaulting to the workspace root. This case is a **delegation-spawned**
session (`delegation_call_name: "claude-sonnet-5-impl"`) whose `sessions` row keeps the
project it was originally spawned against (`Genius`), even after the session later did
substantial work in a different project (`Concordia`, via a dedicated task worktree) and
repeatedly re-registered the claim with `lictor cli task set --branch ... --desc ...`.

`POST /v1/prs/local` derives `repository` / `repoPath` / `branch` straight from the `sessions`
row (`src/bootstrap/core.ts` `submitLocalPrForSession`, no live git fallback), so it resolved
`repository: null` (repo_origin never populated) and failed with `repository_not_registered`
even though the actual worktree (`E:/Document/Ars/.wt-Concordia-parttimer-rework`, branch
`feat/parttimer-schedule-rework`, commits present) was fully ready to submit.

## Evidence

- `GET /v1/sessions` for the affected session (`<session-id>`) showed:
  `repo_path: "E:/Document/Ars/Genius"`, `repo_origin: null`, `branch: "main"`,
  `target_project: "E:\\Document\\Ars\\Concordia"` — `target_project` reflects the later claim,
  but `repo_path`/`branch` (the fields the local-PR path actually reads) do not.
- `lictor cli task set --branch feat/parttimer-schedule-rework --desc "..."` returned
  `{"ok":true,"task":{"branch":"feat/parttimer-schedule-rework",...}}`, but a subsequent
  `lictor cli state` call reported `task.branch: "main"` again — the override did not stick,
  and `sessions.branch` never changed either. `task.branch` (Lictor-local) and `sessions.branch`
  (Cc-side, used for local PR) appear to be two separate fields that are not kept in sync by
  `task set`.
- `POST http://127.0.0.1:11111/v1/prs/local {"session_id":"..."}` → `{"submitted":false,"reason":"repository_not_registered"}`,
  reproduced twice (once before, once after the `task set` re-registration above).
- Note: `src/api/sessions/lifecycle.ts` already contains the `[[2026-08-07-castra-root-session-binding]]`
  fix (the "umbrella root" comment at line ~30 is present in the current working tree), so this
  is a **separate gap**: that fix addresses a root-cwd default; it does not appear to cover a
  delegation session's original spawn-time repo_path being overridden by later explicit work in
  a different project.

## Regression Context

Same class of problem as [[2026-08-07-castra-root-session-binding]] (session repo binding
diverges from the session's actual current work), but a different code path / trigger. Both
share the same downstream symptom: `POST /v1/prs/local` silently resolves the wrong repository
and returns `repository_not_registered` instead of submitting the branch that was actually
worked on.

## Cause

Unconfirmed. Leading hypothesis: `sessions.repo_path` / `repo_origin` / `branch` are set once at
session spawn (from the delegation invoke's `target_repo`/cwd) and are only updated by an
automatic detector tied to specific triggers (e.g. an actual OS-level cwd/branch change observed
by a hook), not by `lictor cli task set`. Since this session's underlying process cwd stayed at
the Ars workspace root for tool calls (Bash `cd` was used per-command rather than changing the
session's own root), the automatic detector may never have fired for the Concordia worktree,
and `task set` was never wired to update `sessions.repo_path`/`branch`/`repo_origin` directly.

## Fix Requirements

- Decide the intended source of truth for `sessions.repo_path` / `repo_origin` / `branch` when a
  session explicitly re-registers a task claim via `lictor cli task set` against a different
  project/worktree than its spawn target, and make `task set` (or an equivalent explicit call)
  actually update those fields — or provide a documented, callable way to do so.
- Alternatively (or additionally), have `POST /v1/prs/local` resolve `repository` with a live
  `git -C <cwd-at-call-time>` fallback when `repo_origin` is null and the caller does not want to
  rely solely on the stored session row.
- Whichever fix is chosen, add regression coverage for: a delegation session spawned against
  project A, whose session later does committed work in a worktree under project B and
  re-registers its claim — local PR submission must resolve project B, not A.

## Verification

- Reproduce with a synthetic session row (repo_path=A, repo_origin=null, branch=main) plus a
  `task set`-style claim override targeting project B; confirm `submitSessionLocalPr` resolves
  project B after the fix.
- Manually confirm `POST /v1/prs/local` succeeds for a real delegation session that switched
  projects mid-session, without requiring the session to be killed and respawned inside the
  target worktree.

## Follow-up

- This session worked around the blocker by leaving `feat/parttimer-schedule-rework` committed
  and clean in `E:/Document/Ars/.wt-Concordia-parttimer-rework`, and reporting the blocker to the
  user instead of forcing submission through an unsupported path.
- Once a fix lands, confirm whether existing stuck sessions need any explicit re-registration
  step (per the Follow-up note in [[2026-08-07-castra-root-session-binding]]) or whether the fix
  self-heals on the next `task set` / gate call.

## Workaround (2026-08-08, neco 指示)

`PATCH /v1/sessions/:id` に `{"repo_path": "<worktree path>", "repo_origin": "<https remote url>",
"branch": "<feature branch>", "target_project": "<project path>"}` を直接投げて手動 rebind したところ、
直後の `POST /v1/prs/local` が即座に `submitted:true` (このセッションでは PR #303) になった。

これで確定したこと: `lictor cli task set --branch ... --desc ...` は `sessions.repo_path` /
`sessions.repo_origin` / `sessions.branch` のいずれも更新しない。更新されるのは Lictor 側の別テーブル
(`lictor cli state` が返す `task.branch` / `task.desc`) のみで、Cc の local PR 提出経路が読む
`sessions` 行とは別物だった。

恒久対策としては、`lictor cli task set` (またはそれに相当する明示 claim 操作) が `sessions.repo_path` /
`repo_origin` / `branch` も同時に更新するようにするのが筋が良い。それまでの回避策は本セクションの
`PATCH /v1/sessions/:id` を手動で叩くこと (Cc endpoint はいつも通り Excubitor catalog から解決する)。

## 追加で踏んだ別バグ: 失敗した local PR の再提出 (retry) が効かない

rebind 後の初回提出は成功したが (PR #303 local id `<local-pr-id>`)、審査中にブランチへ追加 commit
したことで Revisor が `"Local branch 'feat/parttimer-schedule-rework' changed while Revisor was working."`
で `checkStatus: "failed"` になった。

以後、ブランチを安定させた (追加 commit をやめた) 状態で `POST /v1/prs/local` を複数回・時間を空けて
再実行したが、毎回 `{"submitted":false,"reason":"already_open"}` が返り続けた。

`curl http://127.0.0.1:4240/v1/local-prs` (Revisor 自身への直接クエリ、Excubitor 経由で解決した base_url)
では該当 PR の `checkStatus` が一貫して `"failed"` と返っており、`src/pr/local-pr-submission.ts` の
`planLocalPrSubmission` のロジック上は `checkStatus === "failed"` で `retry: true` になり
`deps.revisor.retryLocalPullRequest(...)` が呼ばれるはずだが、実際には `jobId` / `updatedAt` が
複数回のリトライ試行を挟んでも一切変化しなかった (= retry が本当に発火していない)。
`reason: "already_open"` は `planLocalPrSubmission` の non-retry 分岐からしか返らない値なので、
`POST /v1/prs/local` が内部で見ている `openPullRequests` (`deps.revisor.listLocalPullRequests()` の
結果) の `checkStatus` が、直接 Revisor に問い合わせたときの値と食い違っている可能性が高い
(原因未特定: 両方とも `excubitorClient` 経由の live HTTP 呼び出しに見えるコードだったが、実測は一致しない)。

### Fix Requirements (追加分)

- `POST /v1/prs/local` が参照する `openPullRequests` の取得経路と、`GET /v1/prs/revisor` /
  Revisor 直叩き (`GET /v1/local-prs`) の取得経路が同じデータを返しているか実測で突き合わせる。
- 一致しない場合、`submitSessionLocalPr` 側のキャッシュ・トークン解決・エンドポイント解決のどこが
  古い/別の値を返しているかを特定する。
- 失敗した local PR を「安全に手動で再審査キューへ戻す」経路 (retry が壊れている間の代替) を用意する
  か、少なくとも `POST /v1/prs/local` のレスポンスに duplicate の実際の `checkStatus` を含めて
  デバッグしやすくする。

### Verification (追加分)

- `checkStatus: "failed"` の local PR に対して `POST /v1/prs/local` を叩いたとき、実際に
  `deps.revisor.retryLocalPullRequest` が呼ばれる (jobId が変わる) ことを回帰テストで確認する。
