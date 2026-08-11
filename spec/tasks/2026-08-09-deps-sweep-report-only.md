---
task: deps-sweep-report-only
project: Concordia
kind: 運用変更
created: 2026-08-09
memory_links: []
---
# 日次依存関係点検を報告専用にする

## 目的

`deps-sweep-daily` は LUDIARS 全体の依存関係を日次で確認するが、定時実行から依存関係の
更新やコード変更を行わない。更新候補と影響、対応が必要な事項を報告するだけにする。

## 完了条件

- delegation template は入力引数なしで Ars root から実行され、更新・テスト・サービス操作・
  commit・push・PR 作成を指示しない。
- scheduler はテンプレートと同じ引数なしで毎日 7:10 JST に起動する。

## スコープ (編集可ファイル)

- `src/delegation/seed.ts`
- `src/scheduler/cron-jobs.ts`
