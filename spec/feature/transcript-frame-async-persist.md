---
type: feature
title: "transcript-frame の非同期永続化"
description: "受信した transcript frame を bounded batch で SQLite へ永続化し、読み取りと shutdown では保留分を書き切る。"
service: concordia
domain: persistence
tags:
  - sqlite
  - transcript
  - event-loop
  - batching
status: implemented
related:
  - ../tasks/2026-08-09-transcript-frame-event-loop-stall.md
updated: 2026-08-15
---

# transcript-frame の非同期永続化

## 背景

`POST /v1/sessions/:id/transcript-frame` (`src/api/sessions/relay.ts`) は
`TranscriptLogsRepo.insert()` を呼んで受信フレームを `transcript_logs` テーブルへ
永続化する。従来はこの insert が better-sqlite3 の同期 API でイベントループ上
そのまま実行されており、テーブルが肥大するほど 1 回の insert コストが伸び、
イベントループの stall (最大 344,805ms 実測) を引き起こしていた
(`spec/tasks/2026-08-09-transcript-frame-event-loop-stall.md`)。

## 設計

`TranscriptLogsRepo` はメモリキューを持ち、`insert()` は payload の JSON 化を
同期的に検証してからキューへ push し、即座に `true` を返す。実際の SQLite
書き込みは `setImmediate` ごとに
最大 `FLUSH_BATCH_SIZE` (200) 件ずつトランザクションでバッチ commit する。
1 回の flush でキューを消化しきれない場合は次の `setImmediate` に持ち越し、
1 tick あたりの占有時間を一定以下に抑える。

バッチは transaction が成功した後にだけキューから除去する。SQLite 書き込みが
失敗した場合は受理済み frame を保持して 1 秒後に再試行し、復旧するまで新規
`insert()` を失敗させて送信側の再送へ戻す。これにより永続化失敗中の無制限な
キュー増加と、commit 前の frame 消失を防ぐ。`close()` 後の `insert()` も失敗する。

読み取り系メソッド (`listBySession` / `countBySession` / `maxId` / `tsSpan` /
`listUsagePayloads`) は呼び出し直前に同期 flush (`flushSync()`) してから
クエリする。これらは一覧表示・compaction 契機など低頻度パスであり、
未 flush のフレームを読み逃さないことを優先する。

`close()` は保留中の `setImmediate` flush を止め、残キューを `flushSync()` で
書き切ってからハンドル参照を手放す。DB を close する前に必ず呼ぶ必要があり、
`bootstrap/core.ts` の `resources.own(...)` から shutdown フックとして配線する。
呼ばずに DB を close すると、予約済みの flush tick が閉じたハンドルへ
`prepare()` して落ちる。

## 冪等性 / persisted 応答

`insert()` の戻り値は「新規挿入されたか」ではなく「引き受けたか (=いずれ確実に
書かれるか)」を表す。Lictor の transcript sink は `requirePersisted: true` で
このレスポンスを見て再送要否を決める (`Lictor/src/transcript-sink.ts`) ため、
キュー投入時点で `persisted: true` を返す。

キュー投入から flush までの間にプロセスが落ちた場合、その間のフレームは
ロストしうる。これは同期 insert 時代の commit 前クラッシュと同種のリスクで
あり、`FLUSH_BATCH_SIZE` を小さく保ち `setImmediate` 単位で即 flush することで
実用上無視できる窓に抑える。

## 検証メモ

`close()` を配線する前は、DB close 後に予約済み `setImmediate` flush が発火して
`TypeError: The database connection is not open` で落ちることをテストの
unhandled exception として実際に観測した (vitest の `afterEach` で db が close
された直後)。`close()` で `clearImmediate` + フラグ確認により再現しなくなった。

## 完了条件との対応

- フレームの取りこぼし: キュー push は同期的でロスト無し。flush は
  `INSERT OR IGNORE` + UNIQUE(session_id, seq) により再送でも重複しない。
- 順序逆転: 1 セッションのフレームは同一プロセス内でキュー順 (=到着順) の
  まま flush されるため、DB 上の投入順は変わらない。
- `active_requests: 0` の stall (定期タスク側の同期 I/O) は本タスクのスコープ外。
  transcript-frame 経路以外の同期 I/O 源は別途調査が必要
  (`spec/tasks/2026-08-09-transcript-logs-retention.md` の purge 処理などが候補)。
