---
task: teams-core
project: Concordia
kind: 実装
created: 2026-08-13
memory_links:
  - spec/feature/teams.md
  - spec/feature/session-contract.md
---
# チーム基盤 (テーブル + API + Discord プロビジョニング + 契約 team)

## 目的
チームの正本と Discord カテゴリ 6 面を用意し、spawn 時のチーム選択を契約に載せる
(teams §1, §2 / Phase a)。

## 完了条件
- `teams` / `team_repos` テーブルと migration、`POST/GET/PATCH /v1/teams` が揃う
  (director_cases / sessions / delegation_runs への team_id 追加は nullable・後方互換)。
- チーム作成でカテゴリ + 6 面 (目標 / タスクボード / コスト / direction /
  セッションフォーラム / タスクフォーラム) が冪等にプロビジョニングされる。
- 契約 `team` フィールドが repo 一意なら seed 確定、曖昧なら direction チャンネルへの
  質問カードで決まる。`/co-spawn` / `/co-team-create` に team オプションが載る。
- 既存カード類 (case 状態 / taskflow kanban / コスト日次 / 判断ログ) の投稿先が
  チーム面へ切り替わる (未所属はグローバル面のまま)。
- migration・プロビジョニング冪等性・契約連携の単体テストが green。

## スコープ (編集可ディレクトリ)
- src/db/
- src/api/
- src/discord/
- src/contract/
- src/director/
- src/cost/
