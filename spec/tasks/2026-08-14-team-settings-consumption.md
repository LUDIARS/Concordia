---
task: team-settings-consumption
project: Concordia
kind: 実装
created: 2026-08-14
memory_links:
  - spec/feature/teams.md
  - spec/tasks/2026-08-13-team-rules.md
---
# typed TeamSettings を実挙動に配線する

## 目的

PR #516 で `src/api/teams.ts` に typed な `TeamSettings`
(`revisor_lane` / `pr_rules` / `test_policy` / `worktree` / `visibility` / `vibes_defaults`)
の zod スキーマと保存経路は入ったが、この値を読む消費側がリポジトリ内に存在しない
(2026-08-13-team-rules の A 層が保存のみで死んでいる)。設定がセッション実挙動を
実際に制御するよう配線する。

## 完了条件

- `revisor_lane` がチーム所属セッションの Revisor local PR 提出 lane に反映される。
- `test_policy` / `worktree` / `visibility` がハーネス述語または契約シードから参照され、
  チーム所属セッションの該当判定に効く。
- `vibes_defaults` が vibes 契約シードの既定値として使われる。
- `pr_rules` が local PR 提出時の検証または委託 brief に反映される。
- チーム未所属セッションは現行挙動のまま (フォールバック維持)。
- 各消費経路の単体テストが green (設定あり / 未所属フォールバックの両方)。

## スコープ (編集可ディレクトリ)

- `src/contract/`
- `src/harness/`
- `src/pr/`
- `src/api/`
- `src/delegation/`
- 対応するテストファイル
