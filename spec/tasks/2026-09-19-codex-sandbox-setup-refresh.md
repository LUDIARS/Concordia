---
task: codex-sandbox-setup-refresh
project: Concordia
kind: 雑用
created: 2026-09-19
memory_links:
  - C:/Users/raury/.claude/projects/E--Document-Ars/memory/feedback-codex-sandbox-setup-refresh-error.md
  - C:/Users/raury/.claude/projects/E--Document-Ars/memory/feedback-codex-delegation-sandbox-git-denied.md
---
# Codex 委託が Windows sandbox の setup refresh エラーで即終了する

## 目的

2026-09-18、sol-xhigh の委託 2 本が起動 25 秒 / 49 秒で終了した。Codex (codex-cli 0.155.0) の Windows sandbox が
プロセスの起動を拒否している (`exec_command failed: CreateProcess { Rejected("Failed to create unified exec process:
helper_unknown_error: setup refresh had errors") }`)。worktree でも本体チェックアウトでも同じで、Codex 系テンプレート
(sol-* / astra-* / terra-* / luna / impl-from-design ほか) が全滅している。run は `running` のまま、`error: null` で、
状態表示からは原因が見えない。子セッションの終了時には、中身の無い local PR が自動提出された (非公開リポの PR で 1 件発生)。

## 完了条件

- `setup refresh had errors` の原因を特定し、`codex exec --sandbox workspace-write` でコマンドが実行できる状態へ戻す
  (`~/.codex/sandbox.<日付>.log` の world-writable scan FAILED との関係も確認する)。
- 子セッションが 1 分未満で終了し、成果が無い委託 run を、`running` のまま放置せず失敗として記録する
  (watchdog の `child_not_active` は親が無い run では誰にも届かない)。
- 成果の無い子セッションの終了で local PR を自動提出しない (head が base から進んでいない、または委託の成果コミットが無い場合)。
- 長い依頼文が Claude の子へ途中で切れて届く件 (同日 opus-mid で発生、`/v1/delegation/runs/:id/inject` も子の会話に入らなかった)
  を再現し、原因を記録する。

## スコープ (編集可ディレクトリ)

- `src/delegation/`
- `src/api/delegation.ts`
- `spec/tasks/`、`spec/knowledge/problems/`
