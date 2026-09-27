# Goal & Go 注入文の契約テスト回帰

- Date: 2026-09-27
- Status: fixed in working tree
- Area: Concordia workflow Inject
- Severity: Revisor local PR #2099 が action_required となり審査を通過できない

## Summary

Goal & Go に PR の指摘修正・再審査・マージ・反映確認を追加した際、既存の契約テストが旧文の一節を期待したままだった。

## Evidence

- Augur run `r-20260927102432521-eaf8892c` は session-coordination の登録テスト 56 件中、真の失敗 1 件を記録した。残り 55 件の `vitest exited 1 despite reporting the selected assertion as passed` は同じ suite の終了コードに連鎖する。
- `src/control/collaboration-context.test.ts:14` は `PR creation alone does not complete that loop` を期待し、実 Inject は `PR creation or Test OK alone does not complete that loop` と案内していた。

## Regression Context

同じループで PR 修正・再審査・マージ・反映確認まで扱う文面変更の後、契約テストの旧 exact 文字列を照合しなかった。

## Cause

テストが旧文面の部分文字列へ固定され、同じ安全条件をより明確にした新文面と一致しなくなった。実 Inject の承認条件や審査ゲートが失われた事実は確認されていない。

## Fix Requirements

テストを新契約の独立した条件へ更新する。PR 指摘修正・再審査・マージ・反映確認、PR 提出/Test OK のみでは非完了、結果不明の再送とゲート回避の禁止をそれぞれ検出する。

## Verification

Augur の保存 run を読み取り専用で照合し、実 Inject と新しいテスト期待の文字列を静的に確認した。`git diff --check` は成功。単体・統合・動作テストは実行許可がないため未実施。

## Follow-up

修正 commit 後の Revisor 再審査で登録テストの結果を確認する。結果不明の提出・マージを再送せず、既存の人間承認と審査ゲートを維持する。
