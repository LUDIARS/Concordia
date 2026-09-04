---
task: quaestor-mail-watch-renew
project: Concordia
kind: 機能追加
created: 2026-09-04
---
# Quaestor Gmail watch 更新ジョブを追加する

## 目的

Gmail `users.watch` の 7 日間の有効期限が切れる前に、Quaestor の watch 登録を毎日更新し、
リアルタイムメール監視が無音で停止することを防ぐ。

## 完了条件

- `quaestor-mail-watch-renew` テンプレートが Quaestor を作業ディレクトリとする parttimer として登録される。
- テンプレートは Excubitor catalog から Quaestor endpoint を解決し、`POST /v1/mail/watch/renew` を 1 回だけ送る。
- scheduler は JST 4:20 にテンプレートを起動する。
- 既存の `quaestor-mail-sweep` は JST 9:40、12:40、18:40 の登録を維持する。

## スコープ

- `src/delegation/parttimer-prompts.ts`
- `src/delegation/seed.ts`
- `src/delegation/seed.test.ts`
- `src/scheduler/cron-jobs.ts`
- `src/scheduler/cron-jobs.test.ts`
- `tests/cron-scheduler.test.ts`
- `tests/delegation-regression.test.ts`

## 実装判断

- 既存 scheduler は delegation template を invoke する仕組みだけを持つため、HTTP 専用 cron は再利用できない。
  そのため既存 `quaestor-mail-sweep` と同じ最小 parttimer template を追加し、テンプレート内で Excubitor catalog 解決後に更新 endpoint を 1 回だけ呼ぶ。

## テスト計画と検証

- `src/delegation/seed.test.ts` で template の登録内容と catalog 解決・単発 POST の指示を確認する。
- `src/scheduler/cron-jobs.test.ts` と `tests/cron-scheduler.test.ts` で cron 定義と既存ジョブ配列の回帰を確認する。
- `tests/delegation-regression.test.ts` で seed template の公開リストを確認する。
- `rg` により renewal の seed／cron 登録、変更ファイルに `17400` がないこと、既存 sweep が残ることを確認した。
- `git diff --check` と Anatomia `verify` は成功した（出力なし、終了コード 0）。
- `npm test -- ...` と `npm run typecheck` は依存関係未導入によりそれぞれ `vitest` と `tsc` が見つからず未実行。
