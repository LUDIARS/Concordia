---
task: teams-webui
project: Concordia
kind: 実装
created: 2026-08-13
memory_links:
  - spec/feature/teams.md
---
# WebUI /teams (一覧 + 詳細タブ + チームフィルタ)

## 目的
チームの目標・タスク・セッション・コスト・ルールを WebUI で管理できるようにする
(teams §4.1 / Phase c)。

## 完了条件
- `/teams` 一覧 (チームカード: 目標数 / 進行中 case / active セッション / 今日のコスト)
  と詳細タブ (目標・case kanban / セッション一覧 / コストグラフ / ルールエディタ) が動く。
- ルールエディタで A 層 typed form と B 層自然文リストの両方を編集できる。
- Sessions / Taskflow / CostFeed など既存ページに team フィルタが効く
  (チーム選択はグローバルフィルタ)。
- すべて read model で、新しい集計正本を作っていない。
- ページ・フィルタ・エディタのテストが green。

## スコープ (編集可ディレクトリ)
- web/src/
- src/api/
