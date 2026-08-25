---
type: data
title: "ログ保持期間とアーカイブ"
description: "concordia.db のログ系テーブル (transcript_logs / session_messages / rules_log / session_stats) の保持期間を 7 日と定め、JST 01:00–02:59 に zip へ退避して削除し、03:00 の VACUUM へつなぐ。"
service: concordia
domain: persistence
tags:
  - sqlite
  - retention
  - archive
  - sweeper
  - event-loop
status: implemented
related:
  - ./schema.md
  - ../feature/crash-recovery.md
updated: 2026-08-25
---


# ログ保持期間とアーカイブ

## 決定

ログ系テーブルの保持期間は **7 日** (2026-08-24 に 30 日から短縮。DB は直近分だけ、過去分は zip アーカイブへ)。刈った行は削除前に **zip で残す**。退避と削除は毎日 **JST 01:00–02:59** の sweeper 走査だけで開始し、03:00 の nightly VACUUM へつなぐ。sweeper 自身は `VACUUM` を行わない。

— neco 決定 2026-08-20、保持期間改定 2026-08-24

## 背景

`concordia.db` は 2026-08-09 に 1,191 MB、2026-08-20 に 1,500 MB。刈り込み自体は
sweeper に実装済みだったが、保持期間の既定が `CONCORDIA_PURGE_AFTER_DAYS` (90 日) を
共有しており、今の生成速度に追いついていなかった。2026-08-20 時点の実測で
`freelist_count` は 1 — purge がほとんど空きページを生んでいない、つまり事実上
刈れていない状態だった。

Cc は `better-sqlite3` の同期 API を使うため、テーブル規模がそのままイベントループの
停止時間に効く。母数を減らさない限り、非同期化を入れても再発する。

## 対象と保持期間

| テーブル | 時刻列 | 保持期間 | 環境変数 |
| --- | --- | --- | --- |
| `transcript_logs` | `ts` | 7 日 | `CONCORDIA_TRANSCRIPT_LOG_RETENTION_DAYS` |
| `session_messages` | `COALESCE(edited_ts, ts)` | 7 日 | 同上 |
| `rules_log` | `ts` | 7 日 | `CONCORDIA_RULES_LOG_RETENTION_DAYS` |
| `session_stats` | `ts` | 7 日 | `CONCORDIA_SESSION_STATS_RETENTION_DAYS` |

`session_events` は別枠で、従来どおり `CONCORDIA_PURGE_AFTER_DAYS` (既定 90 日)。
セッションの経緯そのものなので、ログ系と同じ期間にはしない。

`liveness_history` / `service_instance_logs` は Excubitor へ移管済みの旧テーブルで、
保持期間ではなく **テーブルごと落とす**対象 (`src/db/obsolete-excubitor-cleanup.ts`)。
サービス停止を伴うので別手順。2026-08-20 時点で未実施 (`liveness_history` に
約 109 万行が残っている)。

## アーカイブ

- 出力先は `CONCORDIA_LOG_ARCHIVE_DIR`、既定は `dirname(CONCORDIA_DB_PATH)/log-archive`。
- ファイル名は `<table>-<YYYYMMDD-HHmmss-SSS>.zip`。追記はせず、走査ごとに 1 ファイル。
  同一秒内に複数回退避しても衝突しないよう、ミリ秒まで含める。
- 中身は `<table>.jsonl` 1 エントリ。1 行 1 レコードの JSON で、DB 内部の `rowid` は
  含めない (復元にも解析にも使わないため)。
- zip の書き出しは `src/shared/zip-writer.ts` の自前実装 (deflate)。`file:` 依存を持つ
  このワークスペースで worktree ごとのインストール差を増やさないため、依存を足さない。

## 手順の順序

**読む → zip をディスクへ確定 → 消す**。逆にすると、退避の途中で落ちたときに行だけ
消えて中身が残らない。zip の書き出しに失敗した周期は 1 行も消さず、次の周期へ回す
(退避できないまま消すより、溜める方が戻せる)。

削除は退避した `rowid` の範囲に対して行うが、条件には保持期間の判定式を必ず再掲する。
読みと消しの間でイベントループへ制御を返すため、その隙に同じ rowid 帯へ入った新しい行を
巻き込まないようにするため (`transcript_logs` は `insert()` が `setImmediate` で遅延
flush するので、実際に起こりうる)。退避前に、そうしたバッファは flush しておく。

## イベントループを止めない分割

- 読み取り・削除とも既定 2,000 行のチャンクに割り、チャンク間で `setImmediate` により
  制御を返す。
- 1 走査あたりの上限は既定 50,000 行。上限に当たった場合は `truncated` を立てて
  ログに残し、残りは次の周期で刈る。

## 夜間実行と VACUUM

zip の同期 deflate と SQLite の同期 DELETE は、チャンク分割後も大きなテーブルでは
イベントループを停止させる。このためログの退避と削除は、sweeper の走査時刻が
**JST 01:00–02:59** に入る場合だけ行う。時刻判定はサーバのローカルタイムゾーンに依存させず、
`src/db/nightly-vacuum.ts` の cron と同じ `Asia/Tokyo` を基準とする。日中の走査ではログ行を
残し、次の夜間窓へ遅延する。session の lost/abandoned 判定、`session_events`、pending task の
掃除はこの窓に制限しない。

ディスク実サイズは `src/db/nightly-vacuum.ts` が毎日 03:00 JST に `VACUUM` して回収する。
ログ削除を直前の窓へ集約することで、当日の削除で空いたページを続く VACUUM の対象にする。
`src/drop-obsolete-excubitor.ts` の手動 CLI にある停止確認と quiet-hours ガードは、旧テーブルを
DROP する別手順として引き続き適用する。

## 実装

- `src/db/log-archive.ts` — 退避と削除の進行制御
- `src/shared/zip-writer.ts` — zip の書き出し
- `src/sweeper.ts` — 対象テーブルの一覧と周期実行
- `src/bootstrap/core.ts` — 保持期間と退避先の解決
