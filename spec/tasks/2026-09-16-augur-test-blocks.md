---
task: augur-test-blocks
project: Concordia
kind: 実装
status: delegated
created: 2026-09-16T00:00:00.000Z
delegation_run_id: 2e5c4351-b301-42bb-8deb-7a6cbd62e7ef
memoria_task_id: 2682
---

# Augur台帳と入口から出口を通す動作テストを置く

## 目的

変更されたConcordiaドメインごとに、全体Vitestへ降格せず、HTTP入口から状態保存または外部transportまでを通す動作テストをAugur台帳から選べるようにする。

## 完了条件

- `C-1 registerRuntimeBlockTest(domain, file): 4ドメインのブロックテストはruntime assuranceとして台帳に存在する`。
- `C-2 lintRegistry(repo): Augur台帳lintは成功し、alwaysレコードは0件である`。
- `C-3 runSelectedBlocks(ids): 指定した4本のブロックテストはpassedになる`。
- `C-4 mapBlockEvidence(source, test): 各ブロックテストは通す入口のsourceとcc.acceptance.jsonで対応付く`。

## スコープ

- `tests/blocks/`、`.augur/tests.jsonl`、`spec/domains/`、`spec/setup/`、`spec/tasks/`
- `tools/augur-register-existing.mjs`、`cc.acceptance.json`

## 制約

- `always` のテスト登録と全体Vitestの実行はしない。
- ランタイムの `src/` は変更しない。
- 初回実行は4本のブロックテストだけとする。

## PR 提出時の記録

- `npx vitest run tests/blocks` は4 test files / 4 tests を passed とした。終了時には workspace 外の `E:\Document\Ars\logs\concordia\cc-live.jsonl` への書込みが sandbox で拒否され、Pino の未処理エラー6件も出力されたため、成功としては扱わず環境上の未解決事項として記録する。
- `node E:/Document/Ars/Augur/bin/augur.mjs tests lint --repo .` は成功した。台帳は90件、`always` は0件である。
- `tools/augur-register-existing.mjs` は `tests/` だけを再帰走査する。そのため `src/**/*.test.ts` はこの再登録の対象外である。
- 台帳の anchors は空である。PR bundle の選定には使えないため、domain bundle から選定を始める。
- 再利用探索では既存の `tests/helpers/test-app.ts` を各ブロックテストの HTTP 入口として利用した。4ドメインの既存 membership に `tests/blocks/<domain>/` を追加し、対応する source は `cc.acceptance.json` で明示した。
- Anatomia の worktree パスを渡した `plan` は未登録 project として失敗した。登録済み `concordia` project を使った `plan` と、PR diff の `verify` は実行した。verify は block-level failure を出力しなかった。
