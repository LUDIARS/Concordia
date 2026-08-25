---
task: director-issue-scout
project: Concordia
kind: 実装
status: done
created: 2026-08-25
delegation_run_id: 869f408c-56df-4dfc-b87a-2c1773b0df59
memoria_task_id: 1395
---
# Director 課題スカウトを実装する

## 目的

Director が既存の case / step / task の観測データから、根拠を示した課題仮説をチームへ進言できるようにする。自動で case や step は作成しない。

## 完了条件

- 読み取り専用の `GET /v1/director/issue-signals` が blocked・停滞・run 予算超過の signal をチーム単位で返す。
- `director-issue-scout` の委託テンプレートと週次チーム fanout cron が登録される。
- `issue-hypothesis` カードを API・イベント契約・Discord タスクボードで一貫して受け付ける。
- API、カードのルーティング／色、seed 回帰のテストを追加する。
- 設計正本 `spec/feature/director-issue-scout.md` を含める。

## スコープ

- `src/director/`, `src/api/director.ts`
- `src/shared/`, `src/discord/`
- `src/delegation/seed.ts`, `src/scheduler/cron-jobs.ts`
- 関連テストと仕様
