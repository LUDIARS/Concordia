---
task: team-surface-card-routing
project: Concordia
kind: 実装
created: 2026-08-14
memory_links:
  - spec/feature/teams.md
  - spec/tasks/2026-08-13-teams-core.md
---
# 既存カード投稿先を team_surfaces のチーム面へ切り替える

## 目的

PR #516 で `team_surfaces` テーブルとプロビジョニング (カテゴリ + 6面) は入ったが、
`team_surfaces` を読むのはプロビジョニングの ID 再利用だけで、既存カード類
(Director case 状態 / taskflow kanban / コスト日次 / 判断ログ) の投稿先は
チーム面に切り替わっていない (2026-08-13-teams-core の完了条件の一部)。

## 完了条件

- `team_id` が確定している対象のカード投稿が、該当チームの所定 surface
  (目標 / タスクボード / コスト / direction) のチャンネルへ行われる。
- チーム未設定・surface 未プロビジョニングの場合は現行チャンネルへの
  フォールバックが維持される。
- どのカードがどの surface へ行くかのルーティング決定に単体テストが green
  (チームあり / なし / 面欠落の 3 系統)。

## スコープ (編集可ディレクトリ)

- `src/discord/`
- `src/db/`
- 対応するテストファイル
