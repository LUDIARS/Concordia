---
task: team-audit-cards
project: Concordia
kind: 実装
created: 2026-08-14
memory_links:
  - spec/feature/teams.md
  - spec/tasks/2026-08-13-team-rules.md
  - spec/tasks/2026-08-13-teams-discord-runtime-verification.md
---
# チーム設定・ルール変更の監査カードを direction 面へ投稿する

## 目的

PR #516 (`8c97ac32f355`) で `team.created` / `team.changed` イベントの購読は入ったが、
ハンドラは Discord レイアウトの再プロビジョニングだけを行い、変更内容の監査カード投稿が
未実装のまま残った (2026-08-13-team-rules の完了条件の一部)。このままでは
`2026-08-13-teams-discord-runtime-verification` の完了条件
「チーム設定またはルールの変更イベントが head-office の所定の面に監査カードとして
1回だけ投稿され、別 guild には投稿されない」を実環境で満たせない。

## 完了条件

- チーム作成・チーム設定変更・`rules_text` 変更のイベントで、該当チームの direction 面
  (`team_surfaces` の `surface='direction'` に保存済みの channel_id) へ変更内容の
  監査カードが 1 回だけ投稿される。
- 投稿は head-office guild のみ。子会社 bot (`subsidiary`) では投稿されない。
- 同一イベントの再配信・bot 再起動で同じ変更の監査カードが重複投稿されない。
- direction 面が未プロビジョニングの場合は安全にスキップし、エラーで落ちない。
- 上記 (1回投稿・subsidiary ガード・冪等・面欠落時スキップ) の単体テストが green。
- 実 Discord guild での確認は本タスクに含めない
  (`2026-08-13-teams-discord-runtime-verification` で行う)。

## スコープ (編集可ディレクトリ)

- `src/discord/`
- `src/db/`
- `src/events.ts` / `src/shared/event-schema.ts` (必要な場合のみ)
- 対応するテストファイル
