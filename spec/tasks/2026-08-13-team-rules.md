---
task: team-rules
project: Concordia
kind: 実装
created: 2026-08-13
memory_links:
  - spec/feature/teams.md
---
# チームルール二層 (typed settings + harness_rules scope + Lictor 注入)

## 目的
チーム独自ルールを機械強制 (A 層) と自然文 (B 層) で Cc / Lictor に効かせる
(teams §3 / Phase b)。MakaiNui (Unity・private・別 org) が成立することが基準。

## 完了条件
- `teams.settings` の typed schema (revisor_lane / pr_rules / test_policy / worktree /
  visibility / vibes_defaults) が定義され、契約 seed・ハーネス述語・Revisor 提出経路が
  これを読む。
- `harness_rules.team_id` (NULL = グローバル) が追加され、ガードプロンプトが
  グローバル + 当該チームをマージして列挙する。
- spawn 時にチームルール文書が Lictor へ渡り、セッションに system-reminder 相当で
  供給される (Lictor 側受け口は Lictor リポの別タスク)。
- チーム設定・ルール変更で direction チャンネルに監査カードが投稿される。
- settings 伝搬・マージ・注入ペイロードの単体テストが green。

## スコープ (編集可ディレクトリ)
- src/db/
- src/contract/
- src/harness/
- src/subsidiary/
- src/control/
- src/pr/
- src/discord/
