# パートタイマーが実作業・報告を終えず退勤する

- Date: 2026-09-09
- Status: fixed in working tree
- Area: delegation-parttimer-inject
- Severity: 定時作業の未実施と成果報告の欠落

## Summary

necoから、日報・メール報告が作業なしで終了し、カイゼンは検知後に報告せず終了するとの報告。
2026-09-03のパートタイマーinject修正に対する再発として扱う。

## Evidence

- ユーザー報告を根拠とし、問題runのログや実機再現は未確認。
- `src/delegation/parttimer-inject.ts`は「報告する」の送信API・送信先・配送確認が未定義だった。
- `src/delegation/seed.ts`のkaizen-dailyは既にcodex / gpt-6-astra / medium。
- `parttimer-prompts.ts`には日報更新・メールsweep・カイゼン実装があるが、未実行と0件の区別が弱かった。

## Regression Context

以前の修正は実装委託用書式との衝突を解消したが、報告を送信する具体的契約が不足していた。

## Cause

先行仮説は、曖昧な報告指示と作業なし扱いによる早期終了。今回の変更だけで実障害の原因確定とはしない。

## Fix Requirements

日報とメールは実作業・件数・未実施理由を報告。Astraカイゼンは実装と報告まで担当。
共通footerにsystem送信と配送確認を定義し、未配送はpartialのwaitとして重複実行を避ける。
明示されたPR停止範囲はカイゼンの委託先にも適用する。

## Verification

契約テストを追加した。テスト実行、サービス起動・再起動はユーザーの指示により行わない。
静的な差分レビューでAPI契約、既定Astra、seed更新経路、追加したテストの文字列契約を確認する。
回帰確認候補: 日報更新不要、メール0件/disabled/失敗、カイゼン検知のみ、報告配送失敗で
それぞれ未実行・正常完了・配送未確認を区別し、送信前にcompleted/退勤しないこと。

## Follow-up

PR後の配備・次回runで実作業と配送を確認する。今回の変更はプロンプト契約であり、
配送証跡をサーバー側で強制検証するものではない。稼働環境への反映は未実施。
