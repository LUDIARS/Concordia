# AIノート通知のマイグレーション 102 の凍結登録漏れ

- Date: 2026-09-11
- Status: fixed in working tree; Revisor revalidation pending
- Area: Concordia / SQLite migration ledger / local PR #1699
- Severity: Revisor の登録テストが失敗し、セキュリティ検査とマージを停止

## Summary

AIノート通知用の migration 102 を追加したが、対応する凍結台帳とスキーマ指紋を更新し忘れた。
型・依存検査だけでは検知できず、Revisor の全体テストで凍結登録の整合性チェックが失敗した。

## Evidence

Revisor #1699、審査対象 `81c794477fb455a2a0d0b6c51852c696e69e9b3f`、
2026-09-11T07:27:42Z の結果。登録ケース `bootstrap` / `lint` / `build` は passed、`test` は failed。
Vitest は 597 files passed / 1 failed / 1 skipped、4778 tests passed / 4 failed / 1 skipped。
失敗した 4 件はすべて `src/db/migration-ledger.test.ts`。

- `freezes every migration that ships`: 凍結台帳に 102 がない。
- `keeps the checksum of every applied migration`: `version 102 は凍結台帳に無い`。
- `keeps the schema that the migrations produce`: 生成後のスキーマ指紋が旧版のまま。
- `writes exactly the frozen checksums into a fresh ledger`: 102 の行が期待値にない。

実行された migrator が記録した 102 の checksum:
`a368896af3ba72b2393606673d0332cd3f7e7340235a6da4437ca571aa9bf3b7`。
生成後スキーマの指紋:
`d7fa0912be90f53932bd2f8eea251977cde3e931fcdd8f26e96ee06df741c1ce`。

## Regression Context

台帳のテストは、過去の適用済み migration 編集による起動障害を防ぐための既存回帰検査。
今回、適用済みの 41〜101 の migration 本体・凍結 checksum は変更していない。
新規追加と同時に凍結登録を行うという既存契約の遵守漏れであり、本番 DB 障害を観測したわけではない。

## Cause and Fix Requirements

`src/db/schema.ts` に 102 と SCHEMA_VERSION 更新だけを入れ、`src/db/migration-ledger.ts` の
変更を漏らした。102 の凍結エントリを末尾に追加し、全 migration 適用後の指紋を更新する。
既存の凍結エントリ・migration SQL・検査ロジックは維持する。

## Verification

Revisor の実測値に加え、102 の version/name/source から checksum を静的に再計算して照合する。
base `71ec69ea` との比較で既存 migration と凍結値の不変を確認する。
修正後は型チェックを行い、同じ local PR を Cc 経由で再審査へ戻す。
セッション自身ではテストを実行しない。登録 `test` と後続検査の合否は Revisor の通知で確認する。

## Follow-up

非ブロックの Anatomia 所見は記録されたまま。今回の修正は台帳登録漏れに限定する。
実宛先の指定と外部投稿の到達確認、Castra の執筆スキル 5 行の commit 許可待ちは別途維持する。
