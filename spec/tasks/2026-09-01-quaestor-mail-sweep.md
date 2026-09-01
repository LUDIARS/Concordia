---
task: quaestor-mail-sweep
project: Concordia
kind: 機能追加
created: 2026-09-01
memory_links: [1784]
---
# Quaestor メール監視パートタイマーを追加する

## 目的

Quaestor のメール取り込みを朝・昼・夕に 1 回ずつ起動し、メール内容を parttimer の文脈へ
渡さずに取り込み結果だけを報告する。

## 完了条件

- `quaestor-mail-sweep` テンプレートが Claude Sonnet 5 の parttimer として登録され、`slot` と
  `date` を受け取る。
- テンプレートは `POST /v1/mail/sweep` の応答 JSON だけを扱い、メール本文・添付・PDF を
  読まない、開かない、取得しない。
- scheduler は JST 9:40、12:40、18:40 に同テンプレートを起動し、時刻に応じた
  `morning` / `noon` / `evening` の slot と実行日を渡す。
- seed と cron の回帰テスト期待値、および delegation 仕様が同じ call_name を登録する。

## スコープ (編集可ファイル)

- `src/delegation/seed.ts`
- `src/scheduler/cron-jobs.ts`
- `src/delegation/seed.test.ts`
- `src/scheduler/cron-jobs.test.ts`
- `tests/delegation-regression.test.ts`
- `tests/cron-scheduler.test.ts`
- `spec/feature/delegation.md`
