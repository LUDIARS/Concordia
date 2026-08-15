---
task: transcript-frame-event-loop-stall
project: Concordia
kind: 実装
domain: persistence
spec: spec/feature/transcript-frame-async-persist.md
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
  → 実装済み (`fix/transcript-frame-async-write`)。設計は
  `spec/feature/transcript-frame-async-persist.md` 参照。メモリキュー +
  setImmediate ごとの分割バッチ commit (FLUSH_BATCH_SIZE=200)。
- 負荷時に `event loop stalled` (lag_ms > 1000) が発生しないことを、実測ログで確認する。
  「テストが通る」ではなく、実 session が複数ぶら下がった状態での実測を根拠にする。
  → **未実施**。build + Excubitor 再起動 + 実運用負荷での実測が必要 (このセッションの
  安全境界外: 起動テスト・再起動は cc-test の claim/release を通す)。
- `active_requests: 0` の stall が残る場合は、その発生源を特定して別タスクに切り出す
  (本タスクで暗黙に握り潰さない)。
  → 未着手。実測後でないと発生有無を確認できない。
- 反映には build + Excubitor 経由の再起動が必要 (cc-test の交通整理に乗せる)。
  → 未実施。PR マージ後の対応。

## 実装メモ (2026-08-15)

- 既存の共有 checkout に未コミットの WIP (メモリキュー + setImmediate flush の実装) が
  あり、意図が本タスクと完全一致していたため、それを専用 worktree
  (`.wt-Concordia-transcript-async`, branch `fix/transcript-frame-async-write`) へ
  `git stash` 経由で移して完成させた。
- WIP には見つけていなかった実バグがあった: `insert()` 後に DB を close すると、
  予約済み `setImmediate` flush が閉じたハンドルへ `prepare()` して例外になる
  (vitest の `afterEach` で db.close() する既存パターンで実際に再現)。
  `TranscriptLogsRepo.close()` を追加し `bootstrap/core.ts` の shutdown フック
  (`resources.own(...)`) に `closeDb()` より前の順で配線して解消した。
- テストを追加 (`src/db/transcript-logs-repo.test.ts`):
  非同期 flush の実挙動 (即時 insert 後は未反映)、`flushSync` 後の反映、
  バッチサイズ超過時の全件反映と順序維持、`setImmediate` tick ごとの分割、
  flush 失敗後のキュー保持と再試行、close 時の書き切り。

## スコープ (編集可ディレクトリ)

- `src/api/sessions/`
- `src/bootstrap/`
- `src/db/`
- `tests/helpers/`
- `spec/feature/`
