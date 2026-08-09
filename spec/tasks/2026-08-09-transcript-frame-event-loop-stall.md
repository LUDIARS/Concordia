---
task: transcript-frame-event-loop-stall
project: Concordia
kind: 実装
created: 2026-08-09
memory_links:
  - project-concordia-event-loop-stall
  - feedback-harness-gate-transient-blip
---

# transcript-frame の同期書き込みをイベントループから外す

## 目的

2026-08-09、Cc が断続的に無応答になる事象を調査した。プロセスは生存しており
`/health` も平常時 50〜134ms で返るが、周期的にイベントループが完全に止まる。
止まっている間は accept キューが埋まり、新規接続が拒否される (調査時、最初の 5 連続
プローブが 2 秒前後で接続失敗した)。

Cc 自身のログが原因を記録していた (`cc-live.jsonl`):

```
"msg":"event loop stalled", lag_ms: 2568, active_handles: 26
"msg":"event loop delay summary", stalls: 2, max_lag_ms: 2843, p99: 48ms
```

直近ログ 2 万行の集計:

| 指標 | 値 |
|---|---|
| stall 回数 | 197 |
| lag 中央値 | 1,429ms |
| lag 最大 | **344,805ms (5分45秒)** |

遅延リクエストの内訳は `POST /v1/sessions/:id/transcript-frame` が 392 件で突出し、
最悪の単発リクエストが 344,821ms。stall の最大値と一致するため、この経路が
イベントループを止めている当事者である。

`src/api/sessions/relay.ts` のハンドラ自体は短いが、`deps.transcriptLogs.insert()` が
`node:sqlite` の `DatabaseSync` による**同期書き込み**で、イベントループ上で走る。
テーブルが育つほど 1 回の insert が重くなり、そのまま全体の停止時間になる。

`active_requests: 0` の stall も観測されており、HTTP 処理中だけでなく定期タスク側の
同期 I/O も疑う必要がある。

関連する規模は [[2026-08-09-transcript-logs-retention]] を参照。

## 完了条件

- transcript-frame の永続化がイベントループを 1 秒以上ブロックしないこと。
  手段は問わない (書き込みのバッチ化 / worker への移譲 / キュー化など) が、
  **フレームの取りこぼしと順序逆転を起こさないこと**。
- 負荷時に `event loop stalled` (lag_ms > 1000) が発生しないことを、実測ログで確認する。
  「テストが通る」ではなく、実 session が複数ぶら下がった状態での実測を根拠にする。
- `active_requests: 0` の stall が残る場合は、その発生源を特定して別タスクに切り出す
  (本タスクで暗黙に握り潰さない)。
- 反映には build + Excubitor 経由の再起動が必要 (cc-test の交通整理に乗せる)。

## スコープ (編集可ディレクトリ)

- `src/api/sessions/`
- `src/db/`
- `spec/feature/`
