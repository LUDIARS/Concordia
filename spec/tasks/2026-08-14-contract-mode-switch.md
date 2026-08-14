---
task: contract-mode-switch
project: Concordia
kind: 実装
created: 2026-08-14
memory_links:
  - spec/feature/vibes-mode.md
  - spec/tasks/2026-08-13-plan-approve-flow.md
  - spec/tasks/2026-08-13-vibes-mode.md
---
# vibes ↔ plan のモード切替を契約更新として実装する

## 目的

2026-08-13-plan-approve-flow の完了条件のうち「vibes → plan 昇格 / plan → vibes 降格
(人間承認のみ) が契約更新として動く」が未実装。`onVibesFileLimit`
(`src/api/register-core.ts`) は昇格を尋ねる質問カードを投稿するが、その回答を消費して
`contract.mode` を実際に切り替える経路が無く、降格経路はどこにも存在しない。
また `planUnapproved` 述語 (`src/harness/predicates.ts`) に単体テストが無い。

## 完了条件

- vibes ファイル上限質問への人間の昇格回答で `contract.mode` が `vibes` → `plan` に
  更新され、plan gate (planUnapproved 封鎖) が有効化される。
- plan → vibes の降格が人間承認経由でのみ行え、承認なしの降格 API/回答は拒否される。
- 切替は human tier の契約決定として記録され、`preserveHumanDecisions` で保持される。
- `planUnapproved` 述語の単体テストが green。
- 昇格・降格・承認なし拒否の単体テストが green。

## スコープ (編集可ディレクトリ)

- `src/contract/`
- `src/harness/`
- `src/api/`
- `src/bootstrap/`
- 対応するテストファイル
