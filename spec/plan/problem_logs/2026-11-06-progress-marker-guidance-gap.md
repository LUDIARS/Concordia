# 10分進捗要求とモニター書式の接続欠落

- Date: 2026-11-06
- Status: fixed in working tree
- Area: autonomous-continuation / session monitor
- Severity: 数値進捗の可視化不足

## Summary

Actio `actio:6f195c99-35a4-4548-a987-f172a59fbc01` の追加残件。
先行の進捗要求・モニター・引継ぎ改善は維持し、要求文の書式案内欠落だけを修正する。

## Evidence

依頼者の観測では03:03:37Zのmonitor page0は15行すべて進捗未確認。
`buildProgressReportGuidance` は自然文の概算%を要求するが、`cc-progress` と正本skillの案内が無かった。
`readMonitorProgress` は本人の現在taskに一致するassistant行の独立markerだけを採用する。
stalled-session-nudgeとrun-watchdogは同じbuilderを使う。

## Regression Context

先行PR #3620/#3621/#3624の再実装ではない。過去の実機観測は依頼本文の記録であり、本担当による再測定ではない。

## Cause

報告要求が正規書式と本人current_task取得手順を伝えていなかった。

## Fix Requirements

共通builderに正本skill/parser参照、marker例、本人sidecar経由のtask取得、現在UTC ISOを案内する。
未知・空taskは未確認とし、自然文fallback・状態変更・停止gate回避を追加しない。

## Verification

ソース型チェック通過。テスト型チェックは既存`tests/qs-lock.test.ts`のmjs宣言不足で停止。
parser整合、両経路への案内の回帰テストを記述。ユーザー指示によりテスト未実行。

## Follow-up

Revisor審査、親監督側の許可済み反映、本人の実報告が自然周期で固定投稿に採用される証拠の確認。
このログは「編集はtask worktreeのみ」という今回の明示指示に従い実装worktreeに置く。
