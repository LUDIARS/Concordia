---
task: contract-acceptance-delegation
project: Concordia
kind: 実装
created: 2026-09-05
memory_links: []
---
# C4 委託の受け入れ条件を契約書式にし、完了証跡を Augur 集計で突合する

## 目的
Augur 設計書 §8 の C4。実装委託の受け入れ条件を契約書式 (`C-n <symbol>(…): <条件>`) で
渡し、受託 AI に契約ファイルを先に書かせる。完了報告の `acceptance_report` の自己申告 `met` を
`augur contracts report --acceptance --json --since <DELEGATION_STARTED_AT>` の集計で突合し、
不一致を `unmet acceptance` として拒否する。

## 完了条件
- `src/delegation/implementation-inject.ts` の受け入れ条件セクションに契約書式の書き方、
  契約ファイルを先に書く手順、`augur inject apply --rule contract-wrap --diff-base <base>` と
  `augur contracts report --acceptance --json --since <DELEGATION_STARTED_AT>` を注入。
  `<DELEGATION_STARTED_AT>` は実行環境に渡した同名の環境変数から、shell に応じた構文で展開する。
  Codex 向けには Augur CLI を `node <Augur>/bin/augur.mjs` の絶対パスで明記するが、パスは
  Augur の設定から実行時に解決し、端末固有の値をソースや注入テンプレートへハードコードしない
- 委託開始時刻 (UTC ISO 8601) を `DELEGATION_STARTED_AT` として子に渡す
- `src/delegation/completion-evidence.ts`: worktree に `augur.contracts.json` がある委託は Augur の
  `--acceptance` を実行し、自己申告と一致しない項目を `unmet acceptance` として completed を拒否。
  契約ファイルがあるのに Augur を実行できない場合も、診断を明示して completed を拒否する。
  契約ファイルが無い委託は従来通り (review_only / parttimer の除外も維持)
- 単体テスト (突合の一致 / 不一致 / 契約なしでの従来挙動 / 契約ありで Augur 実行不能時の拒否)
- `spec/feature/task-workflow.md` §5 または受け入れ条件の節に契約書式を追記

## スコープ (編集可ディレクトリ)
- src/delegation
- src/taskflow
- spec/feature
- tests
