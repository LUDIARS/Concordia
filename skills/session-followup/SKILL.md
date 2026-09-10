---
name: session-followup
description: Ccの自動確認に付いた作業・委託・審査状態を読み、現在必要な確認だけを行う。新しい実行権限は与えない。
---

# セッション状態の確認

Ccが注入したworkflowとstateを使う。状態が不明・古い場合は所属sessionの記録を確認する。

- task-active: 直近の差分と失敗記録を確認し、未完了タスクを既存の許可範囲で続ける。
- delegation-wait: 子の終了通知を待つ。子の作業を重複実行・再起動しない。
- review-needed: 対象workflowの提出手順を確認する。RvはCc経由local PR、GitHubはそのprojectのPR手順。
- review-wait: 審査通知を待つ。審査中を実装停止と誤認して変更や再提出を繰り返さない。
- review-failed: 所見と失敗記録を読み、許可された範囲だけ修正する。検証の実行権限は別途確認する。
- merge-confirmation: 審査通過と対象headを確認し、人間のマージ指示またはworkflowの自動マージ結果を待つ。
- completed: 残作業と反映状態を短く報告する。自動確認を終了指示と解釈しない。
- unknown: 確認できない状態を一行で伝える。workflow、成功、完了を推測しない。

人間の未回答確認がある場合はそれを優先して待機する。自動確認はpush・merge・テスト・shutdownの許可ではない。
