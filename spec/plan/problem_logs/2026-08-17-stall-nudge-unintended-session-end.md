# Stall nudge が待機中セッションを意図せず終了させる

- Date: 2026-08-17
- Status: fixed in working tree
- Area: autonomous continuation / pending questions / session lifecycle
- Severity: high — 人間の確認待ちだった作業セッションが明示的な終了許可なしに閉じる

## Summary

停止セッション向けの自動 nudge が、残作業なしと判断した agent に `/session-end` を促していた。
人間の確認待ちで停止していただけのセッションも、この文面を終了許可と解釈して自発的に
終了処理へ進めた。未回答の質問カードを待っているセッションを nudge 対象から外せない経路も
同時に存在したため、これは安全な待機を壊す regression である。

## Evidence

- `src/control/stalled-session-nudge.ts` の旧 `buildNudgeText()` は、残作業が無ければ
  `/session-end` を実行するよう明記していた。
- AskUserQuestion 由来の質問カードは transcript に ```ask フェンスを残さないため、
  `isAwaitingHumanInput()` だけでは未回答待ちを検出できない。
- 2026-08-17 に、作業途中と見られるセッションが終了しているとのユーザ報告があった。

## Regression Context

未回答質問を自動 inject の blocker とする共通 gate は既に存在していたが、stall nudge は
transcript の ask マーカーだけを確認しており、その gate を通っていなかった。

## Cause

nudge の「停止理由を見直して再開させる」責務に終了許可が混在していた。また、人間待ちの
判定を transcript だけに依存し、質問カードを正本とする経路と接続していなかった。

## Fix Requirements

- 未回答の質問カードがあるセッションは transcript 読みより前に nudge 対象から外す。
- 質問状態の照会に失敗した場合も安全側で除外し、他セッションの走査は続ける。
- nudge は終了指示ではないと明示し、自発的な `/session-end` を促さない。
- 質問カード待ち、回答済み、照会失敗、終了禁止文面を単体テストで固定する。

## Verification

`src/control/stalled-session-nudge.test.ts` に上記の回帰ケースを登録した。Revisor review の
制約に従い、この作業セッションではテストを実行していない。

## Follow-up

Revisor の登録済みテストで nudge の単体テストと既存 pending-question blocker テストが
通ることを確認する。
