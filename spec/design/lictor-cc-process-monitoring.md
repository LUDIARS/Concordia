---
type: design
title: "Lictor/Concordia セッションプロセス監視 — 設計資料"
description: "Lictor ラップセッションと Concordia が spawn する agent process に対する CPU/ネットワーク/プロセスツリー監視の設計。Excubitor にネットワークサンプラが無い点と session-process-reaper が kill 専門で観測/アラートを持たない点の 2 ギャップを埋める。UI 有無はオープンクエスチョン。"
service: concordia
domain: observability
tags:
  - monitoring
  - network
  - cpu
  - process-tree
  - alerting
  - design
status: draft
related:
  - ../setup/observability.md
  - ../feature/session-process-reaper.md
updated: 2026-07-17
---

# Lictor/Concordia セッションプロセス監視 — 設計資料

## オープンクエスチョン (要 neco 確認、着手前に解決)

Memoria task #490 (「Lictor/Cc ネットワーク・CPU・プロセス監視 — 設計資料」) は
**タスクトラッカーのデータ破損バグでタイトルのみ残り、本文詳細が失われた**。
本稿は Excubitor / Concordia / PacketMonitor の実物調査から不足点を再構成した
仮説ベースの設計であり、以下は依頼者 neco の確認が必要:

> **この監視は Excubitor `Monitor.tsx` 相当のダッシュボード/UI を含むか、
> それともバックエンドの指標収集 + アラートのみ (UI なし) で十分か？**

UI ありなら Concordia frontend か Excubitor frontend のどちらに置くかも別途決める必要がある。
本稿は UI 有無を決め打ちせず、収集・アラート部分を先に固める構成にした。

## 背景 — 実在する 2 つのギャップ

### ギャップ 1: Excubitor にネットワークサンプラが無い

`Excubitor/src/memory/` は `cpu-rate.ts` / `cpu-alert.ts` / `process-sampler.ts` /
`host-sampler.ts` / `docker-sampler.ts` / `wsl-sampler.ts` / `collector.ts` と、
CPU・メモリ・プロセスツリーの監視がかなり深い (`spec/data/ontology/performance-monitoring.domain.json`
に登録済み)。`process-sampler.ts` は Windows で `Get-CimInstance Win32_Process` から
pid/ppid/WorkingSet/CPU tick を 1 回の呼び出しで取得し、root pid を根とする部分木の
RSS/CPU を合算する (`sumTreeRss` / `sumTreeCpu`)。`cpu-alert.ts` の `detectSustainedCpu`
は観測窓内で閾値超えサンプルの割合 (sustained ratio) を見て一過性スパイクを弾く。

しかし **ネットワーク I/O を採るサンプラは `src/memory/` に存在しない**。プロセス単位の
bytes sent/recv や接続数を見る仕組みが丸ごと欠けている。

### ギャップ 2: session-process-reaper は「殺すだけ」で「見て知らせる」がない

`Concordia/spec/feature/session-process-reaper.md` の reaper (`control/reaper.ts`) は
OS プロセス走査で Lictor ラッパ / `concordia-agent-client` の孤児を判定し kill する
(既定 5 分周期、`reaperMinAgeSec`=180s、ended から `reaperEndedGraceSec`=300s の猶予)。
これは **ended/abandoned セッションの後始末**であり、**生きている session が暴走 (CPU 高止まり /
ネットワーク大量送出) している最中の観測・アラートは一切やっていない**。reaper は
「死んだ後に掃除する」役割で、「死ぬ前に気づく」役割を持たない。

### 補助: Concordia `src/observability/` はこの監視対象ではない

`spec/setup/observability.md` の「旧 Excubitor」機能は catalog 登録済みサービスの
起動状態/git/バージョンの周期スキャンとログ tail + エラー検知であり、
**セッション単位・プロセス単位のリソース監視ではない**。本設計と役割が重ならないことを
明記しておく。

### 参考: PacketMonitor (未接続の既存資産)

`E:/Document/Ars/PacketMonitor` は tshark + Sysmon ベースのアダプタ単位パケットキャプチャ
ツールで、`start-monitor.ps1` がアダプタごとに tshark を background 起動して
`logs/<adapter>/raw.tsv` (ts/proto/src/dst/port/SNI/HTTP host/DNS query) を書き、
`summary.ps1` が outbound/inbound を集計する。以前 Memoria に配線されていたが撤去され、
現状 Lictor/Concordia とは無接続のスタンドアロンツール。**アダプタ単位の観測であり
プロセス単位ではない** ため、そのままでは per-agent-process の帰属付けができない点に注意。

## 対象範囲

- (1) Lictor がラップするセッションプロセス (`Lictor/src/wrap.ts` が起動、`lictor_pid` を
  `sessions.metadata` に登録)
- (2) Concordia が spawn する agent process (`tools/concordia-agent-client.mjs`、
  SessionStart hook から起動)

**対象外**: ホスト全体監視・他サービスの死活監視 (Excubitor の既存領域)。

## 指標案

| 指標 | 粒度 | 備考 |
|------|------|------|
| CPU% | session (lictor_pid ルートの部分木合算) | Excubitor `sumTreeCpu` + `cpu-rate.ts` のロジックを再利用想定 |
| メモリ (RSS) | session | 同上 `sumTreeRss`。reaper 誤爆防止と同じ pid 木を使い回せる |
| ネットワーク送受信バイト数 | session (可能なら) / adapter (フォールバック) | プロセス単位の per-pid ネットワーク統計は OS API 上重い。現実的には PacketMonitor 型のアダプタ単位キャプチャ + 接続 5-tuple から pid 推定 (Windows は `Get-NetTCPConnection -OwningProcess` で pid 紐付け可) |
| 接続数 | session | 上記と同じ経路で `OwningProcess` 集計 |
| プロセスツリー深さ・プロセス数 | session | `process-sampler.ts` の `sumTreeRss` が返す `procCount` を流用、深さは `ppid` chain から追加算出 |

## 収集方式

1. **CPU/メモリ/プロセス数**: Excubitor `process-sampler.ts` のサンプリングパターン
   (Windows CIM 1 回呼び出し → 全プロセスの pid/ppid/RSS/CPU tick を取得 → root pid の
   部分木合算) をそのまま Concordia 側 (or 新規小コンポーネント) に移植・再利用する。
   root pid は reaper が既に使っている `lictor_pid` / `agent_client_pid` をそのまま使える
   ので、二重の pid 解決ロジックを持たずに済む。
2. **ネットワーク**: 2 案を比較検討する必要がある。
   - **案 A (軽量)**: `Get-NetTCPConnection -OwningProcess <pid>` を tick ごとに叩き、
     対象 pid の接続数のみ追う (bytes は取れない、接続数のみ)。実装コストは低い。
   - **案 B (PacketMonitor 連携)**: PacketMonitor のアダプタキャプチャを常時稼働させ、
     `raw.tsv` の 5-tuple (src/dst/port) を `Get-NetTCPConnection` の pid マッピングと
     突合して bytes/接続数を pid 単位に按分する。bytes 実測ができる代わりに tshark 常駐
     コストと突合ロジックの実装が要る。
   - 初期実装は案 A で「接続数の異常」だけ検知し、bytes 実測が要る場合に案 B へ拡張する
     段階的アプローチを推奨。
3. サンプリング周期は Excubitor の `memory_monitor` (catalog 設定) に倣い、tick 単位で
   OS 呼び出しを 1 回に集約してサービス数 (この場合 session 数) に対し O(1) にする。

## アラート/閾値設計 (たたき台)

`cpu-alert.ts` の sustained ratio 方式を踏襲し、瞬間スパイクではなく「窓内で高止まりが
継続しているか」で判定する:

| 条件 | 案の閾値 | 判定方式 |
|------|----------|----------|
| CPU 暴走 | 窓 (例 60s) 内で CPU% ≥ 80 のサンプル比率が sustainedRatio (例 0.7) 以上 | `detectSustainedCpu` 相当を再利用 |
| ネットワーク過多 | 直近 1 分で送受信 (or 接続数) が閾値超過 (例 接続数 > 50、または bytes > 数十MB/分 — 実測後にチューニング) | 同様の sustained window 方式 |
| プロセスツリー異常増殖 | procCount が session 開始時の想定値の N 倍 (例 3x) を継続超過 | 増分ベース判定 |

アラート発火時の通知先は未確定 (これもオープンクエスチョンに準ずる論点):
- **案 1**: 既存の boyaki (ぼやき) channel / meta channel 経由で Discord に投げる
  (`spec/feature/boyaki-channel.md` の配線を再利用)。
- **案 2**: Concordia の内部イベントとして発行し (`error_tasks` や `runtime-function-metrics`
  的な snapshot API に相乗り)、既存の error-pipeline / auto-fix 対象にする。
- reaper との連携: アラートが「kill 対象候補」を示唆する場合、reaper の
  `POST /v1/admin/reap` 相当の手動トリガーへのショートカットを UI (ある場合) から
  出すと運用が閉じる。

## 関連

- `Concordia/spec/setup/observability.md` — 旧 Excubitor 吸収機能 (本設計とは別領域)
- `Concordia/spec/feature/session-process-reaper.md` — kill 専門の孤児回収、pid 解決ロジックの再利用元
- `Excubitor/src/memory/` — CPU/メモリ/プロセスサンプラの実装パターン参照元
- `Excubitor/spec/data/ontology/performance-monitoring.domain.json` — 既存監視ドメイン登録
- `PacketMonitor/` — 未接続のネットワークキャプチャツール、案 B のビルディングブロック候補
