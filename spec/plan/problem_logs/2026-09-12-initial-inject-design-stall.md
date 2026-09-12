# 初期 inject 後に設計・開始確認が進まない再発問題

- Date: 2026-09-12
- Status: fixed in working tree
- Area: session startup / stalled-session-nudge
- Severity: 設計が固まっても実装が始まらず、必要な人間確認も見えない

## Summary

neco より「初期injectで作業しないことが多い」と再発報告。設計が固まったら開始確認へ進み、
放置セッションの状況確認で設計の状態も判断するよう依頼された。

## Evidence

main `426dd783` の `session-followup-state.ts` は task/delegation/PR だけを判定し、
設計・確認・実装・調整を保持しない。`rule/session-work.md` に設計から開始確認への規則がない。
既存関連記録: `2026-08-09-delegation-initial-inject-stall.md`、`2026-09-10-harness-request-and-recovery.md`。

## Cause

作業段階と設計の合意を示す状態がなく、初期案内・定期案内が次の判断を指定できていない。
今回の個別停止ログを再現したものではなく、報告とソースに基づく診断。

## Fix Requirements

Cc に4段階と根拠を保存し、初期 inject / 放置確認に共通の設計評価・開始確認規則を入れる。
回答待ちを自動解除せず、同じ範囲の開始指示を受けている場合は再確認しない。

## Verification

回帰検証条件は `spec/feature/session-work-phases.md`。バックエンド・テスト用ソース・Web の型検査に成功。
単体・統合・起動テストは未実施。設計と人間の開始指示の意味は会話から判断し、状態 API 自体は実行権限を発行しない。

## Follow-up

### PR #1709 の登録テスト失敗（2026-09-12）

Revisor の登録ケース `test` 内で 2 assertions が失敗（4,787 tests 成功）。
`stalled-session-nudge.test.ts:308` は旧文面の「再実装」を要求し、
`sessions/routes.test.ts:11` は追加した GET/PUT work-phase を公開API一覧に含めていなかった。
bootstrap / lint / build は成功。既存テストの仕様変更への追随漏れが原因。
期待値を更新し、開始確認・対象変更・版競合・監査保存の回帰テストを追加する。
Revisor reviewPlan の registered_tests.run=true に基づき、関連テストを実行してから再提出する。
Anatomia の非ブロック所見 6 関数は Web 表示関数。`@implements CC-...` は
Anatomia の `SPEC-...` 注釈形式に合わないため、正本見出しへの `@spec` 参照を追加する。

検証結果: 関連8ファイル・79 tests 成功、型検査成功、実差分の spec_linkage 成功。
Cc #1710 の反映作業との競合中はテストを開始せず claim を解放し、先行作業の release 後に実行した。
実行後の release も成功。全体の登録テストと security scan は Revisor 再審査で確認する。

本体反映後、設計中・確認待ち・既存実装セッションの表示と巡回文面を確認する。
