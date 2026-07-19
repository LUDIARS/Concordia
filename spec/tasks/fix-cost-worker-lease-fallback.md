---
task: fix-cost-worker-lease-fallback
project: Concordia
kind: 実装
status: done
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

## 実装状況 (2026-07-19 追記)

PR #348 で完了条件を全て満たして main にマージ済み:
`src/bootstrap/cost.ts` の `createCostLeaseWatchTick` が chat/workflow watch と対称化され、
lease 生存中は embedded サンプラ停止、embedded モードは lease 失効で自動再開
(`deps.runtime.start()`)、worker モードは lease 失効時に 1 停止につき 1 回だけ
warn + `reportWorkerDown` → `error.reported` イベント発火 (`src/bootstrap/core.ts` の
`costWorkerWatch` interval から配線)。両方向遷移は `src/bootstrap/cost-lease-watch.test.ts`
で検証済み。Memoria task id 526/527/528/538 の統合対応の一環として 2026-07-19 に再検証:
tsc / vitest (240 files / 1681 tests) / depcruise / build すべて green。
status を pending → done に更新。
