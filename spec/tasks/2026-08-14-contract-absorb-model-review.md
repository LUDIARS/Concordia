---
task: contract-absorb-model-review
project: Concordia
kind: 実装
created: 2026-08-14
memory_links:
  - spec/feature/model-effort-review.md
  - spec/tasks/2026-08-13-session-contract.md
---
# model-review 判定をセッション契約へ吸収し mreview ダイアログを撤去する

## 目的

2026-08-13-session-contract の完了条件のうち「既存 model-review の model/effort 判定が
契約フィールドとして吸収され、単発 `mreview:` ダイアログが撤去される」が未実施。
`src/discord/model-review-dialog.ts` と `commands.ts` の `mreview:` dispatch、
`applyRuntimeModelReview` / `GeniusModelReviewService` の独立経路が
`src/bootstrap/core.ts` に残ったままになっている。

## 完了条件

- model / effort の判定が契約 (seed / LLM / human の三段) の決定として記録され、
  セッション runtime に反映される。
- 単発 `mreview:` ダイアログと独立 dispatch が撤去される (または契約経路への
  完全な置換で到達不能になる)。
- LLM tier (`src/contract/model-review-adapter.ts`) の単体テストが green。
- 従来 model-review が担っていた判定が契約経由で同等に機能することの回帰テストが green。
- `patchContractHuman` / `preserveHumanDecisions` の human 上書き保持がテストされる。

## スコープ (編集可ディレクトリ)

- `src/contract/`
- `src/model-review/`
- `src/discord/`
- `src/bootstrap/`
- `src/control/`
- 対応するテストファイル
