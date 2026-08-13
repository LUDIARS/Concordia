---
type: feature
title: "自走継続 — 朝タスク仕分け + 停止セッション nudge"
description: "朝タスクを確認系/実装系に仕分けして自動処理する morning-tasks delegation テンプレと、transcript mtime を基準に 1 時間応答のないセッションへ続行を促す stalled-session-nudge watcher の 2 機構を定義する。ask 待ち除外・cooldown・fire-and-forget inject など運用上の安全策も規定。"
service: concordia
domain: session-coordination
tags:
  - typescript
  - lifecycle
  - delegation
  - state-machine
  - injection
  - polling
  - resume
  - monitoring
status: implemented
updated: 2026-06-30
---


# 自走継続 — 朝タスク仕分け + 停止セッション nudge

ユーザ指示 (2026-06-23) に基づく 2 つの自走支援機構。 共通の原則:

> **確認系 (人間がやる) タスクは整理して提示するだけ。 実装系 (AI がやれる) タスクは
> 残作業がなくなるまで実装する。 人間の判断が必要になったら ask で止める。**

「止まっている」 の定義 = **transcript が 1 時間更新されていない** こと。

---

## 1. 朝タスクの仕分け処理 (`morning-tasks` delegation テンプレ)

`src/delegation/seed.ts` の `morning-tasks` テンプレ。 `MorningScheduler` が毎朝 8 時に
今日期限の Memoria タスクを取得して invoke する (起動経路は従来通り)。

旧仕様: 「AI 実行可能なものを最大 3 件だけ自動処理、 人間タスクはスキップ」。

新仕様:
- 全タスクを **確認系 (人間がやる)** / **実装系 (AI がやれる)** に仕分ける。
  迷うものは確認系 (人間側) に寄せる。
- **確認系** (実機確認 / ブラウザ操作 / 外部サービス設定 / データ手入力 / 物理操作 /
  対人 / 本人判断) → **実行しない**。 「今日 人間がやること」 として整理して提示。
- **実装系** (コード修正 / CLI / PR / 設定変更 / ステータス更新 / 調査) →
  **残作業がなくなるまで実装** (件数上限なし)。
- 人間の判断が要る点が出たら決め打ちせず **ask で質問して保留** (進行を止める)。
- 最後にサマリ (① 人間がやること / ② AI が実装したもの / ③ 判断待ちで止めたもの) を
  投稿して `/session-end`。

---

## 2. 停止セッションの続行 nudge (`src/control/stalled-session-nudge.ts`)

全 active セッションを周期走査し、 **1 時間応答が無い** ものに「残作業を確認して続行 /
判断が要るなら ask で停止」 を `session.inject` で流し込む watcher。

### idle 判定は transcript mtime
`last_seen_at` は WS ハートビート由来で「プロセス生存」 signal にすぎず idle を表さない。
**transcript ファイルの mtime** を「最後に応答した時刻」 として使う。

### ask 待ちは除外
意図的に人間判断を仰いで止まっている (最後の assistant メッセージが ```ask フェンス) は
nudge 対象から外す — 「続行しろ」 と被せると人間の判断停止を踏み潰すため。
ask の後に user 回答が来ていれば「回答済み」 とみなし除外しない。
判定は `isAwaitingHumanInput()` (純関数、 transcript 末尾 64KB のみ読む)。

### cooldown
一度 nudge したら `cooldownSec` (既定 = idleSec) は再 nudge しない (per-session の
in-memory タイムスタンプで抑止)。 消えた session の記録は毎周掃除する。

### nudge 本文
全 provider 共通の自然言語: ①未完があれば残作業ゼロまで実装を続行 ②判断が要れば ask で
停止 ③残作業が無ければ `/session-end`。

### 設定 (env)
- `CONCORDIA_STALL_NUDGE_ENABLED` (既定 `1`)
- `CONCORDIA_STALL_NUDGE_INTERVAL_MS` (既定 `600000` = 10 分)
- `CONCORDIA_STALL_IDLE_SEC` (既定 `600` = 10 分)
- `CONCORDIA_STALL_NUDGE_COOLDOWN_SEC` (既定 `CONCORDIA_STALL_IDLE_SEC` と同じ)

idle 閾値は巡回間隔と同じ 10 分に揃える (2026-08-09 neco 指示)。 「ゴールへ進んでいない
セッションを 10 分ごとに確認する」が成立するのはこの組み合わせのときだけで、 従来の 1 時間では
止まったセッションを丸 1 時間放置してから初めて声をかけていた。 cooldown も同じ 10 分なので、
1 セッションあたりの催促は最短 10 分に 1 回に収まる。

fire-and-forget: WS 未接続なら inject は silent drop。 status 変更は行わない。
