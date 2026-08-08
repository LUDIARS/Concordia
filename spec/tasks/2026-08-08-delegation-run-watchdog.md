---
title: "委託 run watchdog — 30 分周期の進捗確認と停滞エスカレーション"
status: implemented
service: concordia
domain: session-coordination
updated: 2026-08-08
---

# 委託 run watchdog

「委託して放置」の対策 (2026-08-08 neco 指示)。 委託した場合は状況報告を 30 分間隔で
機械的に確認し、 止まっていたら委託先に確認する。 Cc が管理し、 再起動で監視が
外れないよう永続化する。

## 設計

- `src/delegation/run-watchdog.ts` — 30 分周期 (`CONCORDIA_DELEGATION_WATCHDOG_INTERVAL_MS`)
  で active run (launching/spawned/running) を走査する supervised interval。
- 活動時刻の正本は **transcript_logs の MAX(ts)** (`tsSpan`)。 `last_seen_at` は WS
  ハートビート = プロセス生存にすぎないため使わない (stalled-session-nudge と同方針)。
  計測不能 (null) は触らない。
- 停滞判定: idle >= `admin.delegation_watchdog_idle_sec` (既定 1800) かつ ask 待ちでない。
- 確認: 子セッションへ inject (「進捗を報告せよ / 完了・失敗なら status API へ /
  詰まりは ask」)。 cooldown は idle 閾値と同じ。
- エスカレーション (親へ 1 回だけ inject + delegation.mirror):
  - 子セッションが消えている / active でない (status 報告なしの死)
  - `ws_clients <= 0` で確認が届けられない
  - `admin.delegation_watchdog_max_nudges` (既定 3) 回の確認に無応答
- run の status は書き換えない (queue の stale 判定の責務を侵さない)。

## 永続化

`delegation_runs` に watchdog_* 列を追加 (epoch-ms):
`watchdog_last_check_at` / `watchdog_nudge_count` / `watchdog_last_nudge_at` /
`watchdog_escalated_at`。 cooldown・回数・エスカレーション済みが DB に載るため、
Cc を再起動しても監視と抑止は外れない。 エスカレーションの 1 回きり保証は
`watchdog_escalated_at IS NULL` 条件付き UPDATE (`recordWatchdogEscalation`)。

## 設定

- `GET/PUT /v1/admin/delegation-watchdog { enabled, idle_sec, max_nudges }`
  (既定 ON / 1800 / 3)。 tick が毎回 live 評価するので再起動不要。
- `/v1/admin` snapshot にも露出。

## Tasks

- [x] delegation_runs へ watchdog_* 4 列 (COLUMN_ADDITIONS)
- [x] DelegationRepo: recordWatchdogCheck / recordWatchdogNudge / recordWatchdogEscalation
- [x] run-watchdog worker (supervised interval + 純関数テキスト)
- [x] AdminState 設定 3 点 + admin API + snapshot
- [x] bootstrap 配線 (stalled-session-nudge の直後)
- [x] stalled-session-nudge の transcript 末尾読みを export して ask 判定を共用
- [x] vitest (nudge / cooldown 永続 / ask 除外 / エスカレーション 3 種 / 1 回きり)

## Non-goals

- run status の自動変更・スロット解放 (queue.ts の責務)
- 人間へのメンション (エスカレーションは親セッション inject まで。 親が判断して
  ask / メンション経路に乗せる)
