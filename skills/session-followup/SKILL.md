---
name: session-followup
description: Ccの自動確認に付いた作業・委託・審査状態を読み、現在必要な確認だけを行う。新しい実行権限は与えない。
---

# セッション状態の確認

Ccが注入したworkflowとstateを使う。状態が不明・古い場合は所属sessionの記録を確認する。

- design-assessment: `../session-work-phase/SKILL.md` を読み、会話と現状から設計の状態を判断して Cc に記録する。設計不足なら調査し、固まっていれば開始確認へ進む。同じ範囲の開始指示がすでにあれば根拠を記録して実装を続ける。
- start-confirmation: 人間の開始確認待ちを維持する。直近に回答が届いている場合だけ対象設計と照合し、開始指示なら implementation、設計変更なら design へ記録する。質問を繰り返さず、無応答で実装へ進めない。
- implementation: 記録された設計・人間の開始指示と最新の会話を照合して、許可範囲の未完了実装を進める。実装後の指摘対応は adjustment、範囲変更は design へ記録する。
- adjustment: 合意済みの範囲で指摘・結果に応じた調整を進める。新しい範囲は設計と開始確認へ戻す。調整の状態だけを理由にテスト・再起動・マージを実行しない。

- task-active: 直近の差分と失敗記録を確認し、未完了タスクを既存の許可範囲で続ける。
- delegation-wait: 子の終了通知を待つ。子の作業を重複実行・再起動しない。
- review-needed: 対象workflowの提出手順を確認する。RvはCc経由local PR、GitHubはそのprojectのPR手順。
- review-wait: 審査通知を待つ。審査中を実装停止と誤認して変更や再提出を繰り返さない。
- review-failed: 所見と失敗記録を読み、許可された範囲だけ修正する。検証の実行権限は別途確認する。
- merge-confirmation: 審査通過と対象headを確認し、人間のマージ指示またはworkflowの自動マージ結果を待つ。
- completed: 残作業と反映状態を短く報告する。自動確認を終了指示と解釈しない。
- unknown: 確認できない状態を一行で伝える。workflow、成功、完了を推測しない。

人間の未回答確認がある場合はそれを優先して待機する。自動確認はpush・merge・テスト・shutdownの許可ではない。
