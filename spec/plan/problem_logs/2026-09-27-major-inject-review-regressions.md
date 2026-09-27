# 主要 Inject 編集の登録テスト回帰

- Date: 2026-09-27
- Status: fixed in working tree
- Area: Concordia major Inject、migration、session follow-up
- Severity: Revisor local PR #2095 が action_required となり、審査を通過できない

## Summary

Revisor の登録テストが複数 domain で失敗した。Augur の同日 08:52 台の run 記録では、同じ失敗が複数 domain に再登録されている。テストの実行数を domain の件数から推測しない。

## Evidence

- `src/db/migration-ledger.test.ts` は `41:baseline-v41` の checksum 不一致と schema fingerprint 不一致を報告した。feature 差分が `src/db/schema.ts` の凍結済み `STATEMENTS` に `major_inject_overrides` と `delegation_template_prompt_edits` を追加していた。
- `src/control/stalled-session-nudge.test.ts:323` は外部状態取得なしの自動確認に `state=unknown` が無いと報告した。`buildNudgeText` が旧文面へ分岐していた。
- `src/control/startup-policy.test.ts:18`、`src/delegation/persona-context.test.ts:112`、`tests/escalation-api.test.ts:120`、`src/api/sessions/routes.test.ts:11` は既定文面または公開 route 表との不一致を報告した。
- `tests/harness-reliability/conflux.test.ts` の実 Git `switch -c` は失敗した。該当 source/test は `main..HEAD` に差分がなく、原因は未特定。

## Regression Context

主要 Inject の文面正本化と新規 API 追加の後、既存の凍結 migration に新しい表を直接追加したこと、旧文面 fallback と固定 route 期待を更新しなかったことが回帰した。

## Cause

DB の確定原因は、適用済み baseline-v41 の SQL を書き換えたこと。これを許すと既存 DB の `schema_migrations` と実装 checksum が食い違い、次回起動時に migration が停止する。Conflux 失敗の原因は、この記録だけでは確定しない。

## Fix Requirements

凍結済み v41 と既存 checksum を戻し、2 表を末尾の新番号 migration で作成する。新番号だけを凍結台帳へ加え、schema fingerprint を新スキーマに合わせる。外部状態が不明な自動確認は unknown を示し、人間待機と未許可の終了禁止を維持する。開始承認・task 更新案内・公開 route の契約を新仕様と照合する。

## Verification

Revisor/Augur の既存失敗記録と source 差分を読み取りで照合した。凍結済み v41 checksum は `3c3b993588446d9884b382760255623d60b2e72ca8fefcef447e6ec29c673ccc` に復帰した。新 v112 checksum と全スキーマ指紋を一時メモリ DB で算定した。`git diff --check` と `npm run build` は成功。`npm run typecheck` は本体を通過し、今回差分外で main と同一の `src/pr/revisor-local-pr-client.test.ts:33` TS2322 が残る。今回の修正に対する単体・統合・動作テストは、ユーザーの実行許可がないため未実施。

## Follow-up

修正 commit 後に Revisor の再審査結果を確認する。Conflux の実 Git 失敗が再現する場合は独立した失敗として実行環境・Git 出力を調べる。サービス起動・再起動や本番 DB 台帳の変更はこの対応に含めない。
