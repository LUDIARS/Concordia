---
task: team-management-surface
project: Concordia
kind: 実装
created: 2026-09-04
memory_links:
  - spec/feature/teams.md
  - spec/feature/staff-roster.md
  - spec/tasks/2026-08-14-team-surface-card-routing.md
---
# チームに `管理` 面 (権限者限定) を追加する

## 目的

Actio `spec/feature/team-task/spec.md` §8.3 / §10「Cc 側変更 1」。
Actio がチームへ出す報告のうち、遅延レポート (`delay`, §7) と調整提案 (`adjust`, §16.3) は
**メンバー全員に見せるものではない**。既存の 目標 / direction 面はチーム全員が読めるため、
これらを載せる先が無い。

権限者限定の `管理` 面 (保存・routing キーは `management`) を面の集合に足し、`team-provision.ts` が
permission overwrite 込みで冪等にプロビジョニングできるようにする。

## 完了条件

- 面の集合に `management` が加わり、`team_surfaces` に他の面と同じ形で保存される。
- `team-provision.ts` が表示名 `管理` の text チャンネルを作成し、`@everyone` の
  `ViewChannel` を deny する。`staff_members` の Discord ユーザのうち role が
  `manager` / `executive` の ID だけに閲覧を allow し、未登録・`staff` は許可しない。
  Concordia bot の guild member にはカード投稿に必要な閲覧・送信権限を明示的に allow する。
- 再プロビジョニングが冪等 (既存チャンネル・既存 overwrite を重複作成しない)。
  昇格した ID への許可追加だけでなく、降格・名簿削除された ID の古い許可も除去し、
  名簿と overwrite を一致させる。
- 起動時と Discord 社員名簿の role 更新・削除時に既存 `management` 面の overwrite を
  再同期する。同期失敗は握りつぶさず、どの team の権限が未反映かを観測可能にする。
- 既存チームへの後付けプロビジョニングでも `management` だけが追加され、
  他の面の設定を書き換えない。
- 子会社 (subsidiary) guild では本社と同じ規則で扱う。
- 上記 (作成 / `@everyone` deny / bot の投稿権限 / 管理職・執行役員 allow /
  ヒラ社員 deny / 昇降格・削除時の同期 / 冪等 / 後付け) の単体テストが green。

## 依存

なし。`delay` / `adjust` カード (2026-09-04-team-card-kinds-review-delay-adjust) の前提になる。
