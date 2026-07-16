---
task: fix-cost-worker-lease-fallback
project: Concordia
kind: 実装
status: pending
created: 2026-07-16T00:00:00.000Z
source_session: lictor-340dbfff-25a8-4bd0-9a66-8ba0a0ceb69e
memoria_task_id: 527
pr_number: 348
actio_task_id: null
memory_links: []
---
# cost-worker lease 失効時に計測が黙って止まる問題の修正

## 目的

`CONCORDIA_COST_MODE=worker` 運用で cost-worker プロセスが死ぬと
(実測: lease pid 55236 は 2026-07-15T15:45Z が最終 heartbeat、
cost_usage_samples は 2026-07-13 で途絶)、誰も気付かず cost 計測が停止する。
chat-worker / workflow-worker の lease watch は失効時に embedded へ復帰するが、
cost だけ逆方向フォールバックが無い (bootstrap/core.ts:1048-1052 は
「lease が生きていたら embedded を止める」片方向のみ)。

## 完了条件

- worker モードで lease が失効した場合に warn ログ + `error.reported`
  イベント (既存 errors チャンネル通知経路) を出す。復帰 (worker 再起動 or
  embedded 切替) の判断が人間/上位に見えるようにする。
- embedded モードで lease 失効を検知したら embedded サンプラを再開する
  (chat/workflow watch と同じ対称性)。
- ユニットテストで両方向の遷移を検証。

## スコープ (編集可ディレクトリ)

- src/bootstrap/ (core.ts の watch 部, cost.ts)
