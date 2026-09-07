---
task: session-attachment-route
project: Concordia
kind: 実装
created: 2026-09-08
memory_links:
  - spec/plan/problem_logs/2026-09-08-attachment-wrong-channel.md
---
# 資料添付のinject案内をセッション宛て専用経路へ修正する

## 目的
資料が共通報告チャンネルへ誤配送されず、現在のDiscordスレッドへ届くようにする。

## 完了条件
- 成功例と失敗例の配送記録・送信経路を比較する。
- 専用send-file経路とfiles/caption、送信先・配送記録の確認を共通injectへ明記する。
- 資料を正しいスレッドへ再送し、受付と配送を区別して報告する。
- 無断の再起動・テストはしない。

## スコープ (編集可ディレクトリ)
- src/control/session-work-policy.ts
- spec/setup/spawn.md
- spec/plan/problem_logs/
