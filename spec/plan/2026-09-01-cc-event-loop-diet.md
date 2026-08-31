# Cc イベントループ軽量化 (2026-09-01)

> neco 指摘「Cc のイベント重くない？」→ 調査 → 「軽量化PRを作る」。

## 観測 (cc-live.jsonl 2026-08-31)

- p99 は 33〜40ms と健全だが、 **max_lag 500〜900ms が毎分**、 **1〜3.7 秒の stall** が頻発。
- stall 直前のログ:
  - `POST /v1/harness/gate` が **毎回 1.0〜1.3 秒** (最多。 ツール実行ごとに発火)
  - `sweeper` の purge/requeue 直後 (60 秒周期)
  - `POST /v1/harness/context` 1〜9 秒
  - `GET /v1/prs/revisor` 0.9〜3.8 秒 (応答 890KB、 cache TTL 2 秒)
  - nightly vacuum 20.5 秒 (03:00 JST、 仕様どおり)
- **`concordia.db-wal` が 375MB (DB 本体 375MB と同サイズ)**。 `journal_size_limit = -1`、
  `wal_autocheckpoint = 1000`。 手動 PASSIVE checkpoint は 23ms で完走 (log=757 全件) =
  調査時点ではリーダーに阻まれていないが、 03:00 の TRUNCATE 後に朝までに 375MB まで
  膨らんだ = **数時間、 長時間リーダーが snapshot を握って checkpoint が進まなかった**。
  WAL が閾値超えのまま阻まれると、 **毎コミットが checkpoint を試行して部分失敗**する。
  gate / sweeper / context の書き込みが一律 ~1 秒詰まるのはこの機構と整合する。

## 対策 (このブランチ)

| # | 変更 | 効果 |
|---|---|---|
| 1 | `db/index.ts`: `PRAGMA journal_size_limit = 64MB` | checkpoint 完了時に WAL を切り詰め、 膨張の後遺症を残さない |
| 2 | `db/wal-guard.ts` (新規): 5 分ごとに PASSIVE checkpoint + 健全性判定。 飢餓 (log > checkpointed / busy) や上限超えを **warn で可視化** | 「誰が snapshot を握っているか」を追える。 阻まれていない時間帯は先回りで checkpoint を進め、 毎コミット試行の穴を減らす |
| 3 | gate: `audit.recent({limit:1000})` (全カラム 1000 行、 ~200ms) → `audit.editedFilePaths(session_id)` (index に乗る 1 カラム DISTINCT) | ツール実行ごとの同期ブロックを削る |
| 4 | migration 80: `session_events(ts)` index | sweeper の `purgeEventsOlderThan` が毎分 64k 行をフルスキャンしていたのを解消 |

## 残 (別対応)

- 長時間リーダーの特定: wal-guard の warn が出た時刻と、 同居プロセス (concordia-control /
  concordia-cost / chat-worker) や外部 (Revisor 等) の DB 読み取りを突き合わせる。
- `GET /v1/prs/revisor` の 890KB 応答 (cache TTL 2 秒) — digest 利用への誘導 / TTL 見直し。
- `POST /v1/harness/context` の 9 秒 stall (blackbox snapshot の可能性) — wal-guard 導入後に再観測。
- migration 版数: 並行開発時に 79 を予約して本ブランチを 80 としたため、 現在の台帳には
  意図的な欠番がある。 適用済み候補の identity を変えないため 80 を維持する。
