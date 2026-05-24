# Concordia — 設計レビュー (2026-05-17)

評価: **A-**

### 1. 設計強度 (Design Robustness)

| 評価 | 観点 | 所見 |
|------|------|------|
| A | 障害分離 | Excubitor 統合前は sessions/tasks/chat の 3 schema に分離していたが, 統合後も observability/ サブディレクトリで物理分離 (db/client, db/schema). service catalog の変更検知は watcher.ts (file-based) で独立 loop, docker instance sync.ts で別 timer. 障害の伝播経路明確. |
| A | 冪等性 | catalog sync (src/observability/catalog/sync.ts:30-47) は既存 service の upsert をキー (code) で判定→update, 重複 sync は safe. rule compile failure (src/observability/log/error-detector.ts:76-78) は warn だけで rule ロードは継続 (safe fail). auto_fix runner の branch already exists → git switch 失敗時 warn + continue (src/observability/auto_fix/runner.ts:78-79). |
| B | 入力バリデーション | `StartSchema` (src/processes.ts:18-26) / `ControlBodySchema` (src/observability/index.ts:40-42) は zod で型チェック. 但し error_rules の pattern validator が **regex ReDoS 対策なし**. `POST /v1/error-rules` (src/observability/index.ts:304-318) で pattern が string.min(0).max() の制約なし (unbounded string). rule_id, service_instance_id も foreign key 制約のみで参照無欠性実際 validate せず. |
| B+ | エラーハンドリング | observability 層の router (src/observability/index.ts) は resolveTaskAndService() で 404/400 return (line 237-257). auto_fix_runner は失敗の場合 inFlight.delete() 後 throw (src/observability/auto_fix/runner.ts:44-51, 71, 83-95). 単 error_tasks の状態更新と run record 作成の間に race ありえる (error.ts:69 と runner.ts の db.run が atomic ではない). |
| A | リトライ・タイムアウト設計 | src/observability/auto_fix/runner.ts:59 は cliTimeoutMs=10min (src/observability/config.ts:59). verifyTimeoutMs=90sec (line 64). docker control はなし (local spawn only). error-detector は 60s dedup window (src/observability/log/error-detector.ts:line 6 コメント) + rule reload 30s interval (line 34). 30s latency は "新規 rule 即時反映" requirement には不足の可能性. |
| A- | 状態管理の明確性 | error_tasks.state (src/observability/db/schema.ts:102) = 'open'\|'ack'\|'resolved'\|'dismissed'\|'snoozed' で明確. auto_fix_runs.state (src/observability/db/schema.ts:119) = 'pending'\|'fixed'\|'failed'\|'verified' で状態機械定義. 単, error_tasks と auto_fix_runs の update を論理的に追跡する際, error_task.auto_fix_state (src/observability/db/schema.ts:107) が重複情報 (auto_fix_runs.state と異なる値の可能性). |

### 2. 設計思想の一貫性

| 該当箇所 | 逸脱内容 | 本来の設計思想 | 推奨修正 |
|----------|---------|--------------|---------|
| `src/observability/index.ts:204` | リクエスト actor を header `x-concordia-actor` から read するが検証なし | loopback 環境信頼前提だが, tailscale 越境前に provider lookup 必要 | actor header validate 層追加 |
| `src/observability/auto_fix/runner.ts:97-100` | pickUnsafeFiles() 関数は定義あるが, 呼出後ロジックが一部 (100+ line) 省略 (可読性問題) | cleanly fail on risk file | runner の safeguard section を別関数に抽出 |
| `src/observability/log/bus.ts` | eventBus pattern だが observability subscriptions と core dispatcher (src/events.ts) が別実装 | イベント broadcast 統一 | common event bus に merger (両側 subscribe を 1 つに) |
| `src/server.ts:16-29` | bootObservability() 呼出が startBackend() 内 sync point (await) だが, catalog watcher / scanner は background | startup ブロッキング最小化方針と矛盾 | 必須 bootstrap (DB schema, default rules) のみ sync, watcher/scanner は startupAfter() で分離 |

### 3. モジュール分割度

| モジュール / クラス | 凝集度評価 | 所見 |
|-------------------|-----------|------|
| `src/observability/index.ts` (355 行) | 通信的 | bootstrap + router を 1 ファイルで担当. bootstrap は catalog loader, DB sync, daemon starts で機能的に別個. 推奨: `src/observability/bootstrap.ts` + `src/observability/router.ts` に分離. |
| `src/observability/auto_fix/runner.ts` (357 行) | 手続的 | branch create → claude spawn → git diff → commit → restart → verify の明確な順次パイプライン. 単, collectChangedFiles / pickUnsafeFiles / runClaudeCli 等が inline (行数縮減のため集約). 他 use case (investigate.ts) と helper 共有が不十分. |
| `src/observability/log/error-detector.ts` | 機能的 | rule reload + line matching + error_task upsert 3 責務を分担可能 (reloadRules, matchLine, upsertTask に関数抽出可能だがすでに概ね済). OK. |
| `src/observability/scanner/loop.ts` | 順次的 | docker / git / host / package スキャンを 1 loop 内で順次実行. それぞれ sync.ts を call して実作業は委任. 構造 OK, 単 scan 並列化オプションなし. |
| `src/observability/control/manager.ts` (130 行) | 機能的 | service 制御 (start/stop/restart) と docker-compose runner を区分. 責務明確. |
