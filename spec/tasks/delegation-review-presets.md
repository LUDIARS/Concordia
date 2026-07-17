---
task: delegation-review-presets
project: Concordia
kind: 実装
status: pending
created: 2026-07-17T00:00:00.000Z
source_session: lictor-340dbfff-25a8-4bd0-9a66-8ba0a0ceb69e
memoria_task_id: 542
actio_task_id: null
memory_links: []
---
# Delegation テンプレートの調整 (Sol Ultra / Sol 既定 / レビュー一本化)

## 目的

neco 指示 (2026-07-17):
1. Delegation に Sol Ultra を明示的に用意する
2. Codex の Sol のデフォルトを high fast にする
3. レビューの起動は 1 つだけ (Opus と Sol xhigh の突合をデフォルト)
4. プロンプト起動後に調整できるようにする
5. レビューの配置フォルダを「Review」にする
6. レビュー用に Inject Prompt を調整する

## 完了条件

- seed テンプレートに codex-5-6-sol-ultra (gpt-5.6-sol / reasoning ultra) が追加される
- codex-5-6-sol の runtime_options が { model_reasoning_effort: high, fast_mode: true } になる
- レビュー起動テンプレが review-duo (Opus × Sol xhigh 突合、単一起動) に一本化され、
  review-sonnet5 は is_active: false になる
- review-duo は起動後の追加指示 (inject) による構成調整を明示し、sol_effort 等を
  入力パラメータでも上書きできる
- レビュー出力先が E:\Document\Ars\Review\<repo>\<date>\ に統一される
  (daily-review-reconciliation / review-fix の旧 reviews\ 参照も更新)
- レビュー作法 (worktree 不要・ブランチ切替不要・コード変更禁止) がプロンプトに入る
- seed テスト更新 + tsc/vitest 緑

## スコープ (編集可ディレクトリ)

- src/delegation/ (seed.ts, seed.test.ts)
