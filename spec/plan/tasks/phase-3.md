---
type: plan
title: "Phase 3 タスク指示書 — プロセス分離 (cost-worker / chat-worker / event 契約)"
description: "3軸分離リファクタリングの Phase 3 実装指示。cost の JSONL 走査を cost-worker プロセスへ分離しイベントループブロックを根治、discord-worker を chat-worker (Discord+Slack) へ昇格、ConcordiaEvent union の名前空間分割と WS wire 契約のバージョン付け (V12)。安定化の本丸。"
service: concordia
domain: architecture
tags:
  - refactoring
  - task-instructions
  - process-isolation
  - worker
  - event-contract
status: planned
related:
  - README.md
  - ../refactor-3axis-architecture.md
updated: 2026-07-02
---

# Phase 3 タスク指示書 — プロセス分離

前提: T2-2 (bootstrap 分割) 完了。 T3-2 はさらに T2-4 完了が前提。
判断基準: **worker が死んでもコアが死なない・worker 不在でも embedded で動く**。

---

## T3-1: cost-worker プロセス分離 {#t3-1}

### 目的
cost の JSONL 走査 (`~/.claude/projects/**`, `~/.codex/sessions/**` の
ファイル走査) と sampler をコアプロセスから追い出し、 イベントループブロック
(#255/#257 系) をプロセス境界で構造的に根治する (計画 §4.2, §5 Phase 3-1)。

### 対象
- 新規: `src/cost-worker.ts` (エントリポイント)、
  `package.json` scripts に `"cost:worker"`
- 変更: `src/bootstrap/cost.ts` (embedded/worker 両対応)、
  `src/server.ts` (`COST_MODE=worker` 分岐)
- 参考実装: `src/discord-worker.ts` の lease パターン (`discord/relay-owner.ts`)

### 手順
1. `src/cost-worker.ts`: `.env` 読み → `openDb` (同一 SQLite, WAL) →
   `bootstrap/cost.ts` の runtime を起動。 sampler は従来周期で走り、
   結果を既存 `cost_*` テーブル (`cost_daily_usage`, `cost_usage_samples`,
   `cost_limit_samples`) に書く。 **書き込み先スキーマは不変**。
2. lease: `relay-owner.ts` の lease 機構を汎用化 (`shared/worker-lease.ts` に
   role 引数付きで移し、 discord 側は既存挙動を維持したまま再利用)。
   cost-worker が lease を持つ間、 コアの embedded sampler は起動しない /
   後から worker が来たら embedded 側が退く (server.ts の既存 discord パターン
   :727-748 と同型)。
3. コア側で cost 読み取りが必要な箇所の整理:
   - 予算判定 (`CostUsageTracker.isBlocked` / `status`) — worker が書いた
     `cost_daily_usage` 行の読み取りだけで判定できるよう、 tracker を
     「sample する側 (worker)」と「読む側 (core)」に分ける。
   - `/v1/cost/*` API — 集計キャッシュ (windowed/channel-cost) が worker 側で
     しか温まらないため、 worker モード時はコアの API ハンドラが
     **JSONL を直接走査しない**こと。 サンプル済みテーブル + 必要なら
     worker が定期的に書く集計スナップショット (既存テーブルの範囲で) から
     応答する。 応答形状は不変。 直近データの鮮度低下 (sampler 周期分) は許容。
   - `report/generator.ts` (session-cost) と `control/auto-compaction.ts`
     (context-estimate) — セッション単発の軽い読みなので当面コア側に残して
     良い (対象 1 session の JSONL tail 読みは全走査と負荷が桁違い)。
     ただし読み量に上限があることをコードコメントで明記。
4. `COST_MODE=worker` を server.ts に実装 (T2-2 で骨組み済み)。
   デフォルトは embedded のまま。
5. `dev-process.md` の `concordia.processes` フェンスに
   `cost-worker` を追記 (`auto_start: false`)。

### 受け入れ条件
- [ ] `COST_MODE=worker` + `npm run cost:worker` で: cost レポート・予算判定・
      `/v1/cost/*` が従来どおり機能 (レスポンス比較を PR に記載)
- [ ] cost-worker を kill してもコア API は 5xx を返さない
      (cost 系 API は stale データ or 空で応答)。 worker 再起動で自動復帰
- [ ] embedded モード (デフォルト) は従来と完全同一挙動
- [ ] コアプロセスの event-loop lag p99 (T0-5 の計測) が、 cost 集計実行中も
      embedded 時より悪化しない実測を PR に記載
- [ ] 二重 sampler (embedded+worker 同時) が lease で防止される
- [ ] `npm test` green

### やらないこと
- cost データの HTTP 化・新テーブル追加。 SQLite 同居 + 既存スキーマの範囲で行う。

---

## T3-2: chat-worker 昇格 (discord-worker + Slack 収容) {#t3-2}

### 目的
既存 `discord-worker.ts` を `chat-worker.ts` へ改め Slack も収容、
チャット I/O 全体をコアから分離可能にする (計画 §5 Phase 3-2)。

### 対象
- `src/discord-worker.ts` → `src/chat-worker.ts` (rename + 拡張)
- `package.json`: `discord:worker` → `chat:worker` (旧名は当面 alias で残す)
- `src/bootstrap/chat.ts` — worker からの再利用面
- `src/discord/relay-owner.ts` — lease の role を chat 全体へ拡張
  (T3-1 で汎用化済みの `shared/worker-lease.ts` を利用)

### 手順
1. `git mv` で rename 後、 `bootstrap/chat.ts` から Slack bot 起動も worker に
   収容する (deps は T2-2/T2-4 で bootstrap 共用化済み)。
2. lease を「discord relay」から「chat relay」へ拡張: worker が生きていれば
   embedded の Discord/Slack **両方**が退く。 後方互換: 旧 lease キーしか
   書かない旧 worker が生きている場合は Discord のみ退く (移行期対応)。
3. worker の core アクセスを点検し、 repo 直読みを T2-4 の read-model 関数
   経由に揃える。 read-model がプロセス境界を跨げない箇所 (worker は別プロセス)
   は次のいずれかで埋める: (a) 同一 SQLite 読み (read-model 関数を worker 内で
   同じ DB に対して呼ぶ — 当面の既定)、 (b) 既存 WS イベント、 (c) 既存 HTTP API。
   **新規 HTTP エンドポイント追加は事前に人間に確認** (README 共通ルール 7 に準ずる)。
4. reconcile (WS 切断中の取りこぼし救済、 5 分周期) を Slack 分にも適用。
5. `dev-process.md` の processes フェンスを更新 (`chat-worker`)。

### 受け入れ条件
- [ ] `CHAT_MODE=worker` + `npm run chat:worker` で Discord/Slack の
      ingress/egress・RWF・question・permission カードが従来どおり動く
      (確認チェックリストを PR に記載)
- [ ] chat-worker kill → コア API/hook は無影響、 再起動で リレー再開 +
      reconcile が取りこぼしを救済する
- [ ] embedded モードは従来どおり。 embedded 稼働中に worker 起動 →
      lease により embedded が退く (二重リレーなし)
- [ ] `npm test` green

### やらないこと
- subsidiary bot の配置変更の再設計 — 現行の discord-worker が subsidiary
  manager を持つ構図を踏襲する。
- WS プロトコルの刷新 (T3-3 のスコープ)。

---

## T3-3: V12 — event 契約の名前空間分割とバージョン付け {#t3-3}

### 目的
`events.ts` の `ConcordiaEvent` union (全軸混載) が WS 経由で worker への
wire 契約になっており、 どの軸の変更も他プロセスを壊しうる。 名前空間を分け、
WS に流す部分を versioned な契約として `spec/interface/service-schema.md` に
正本化する (計画 §5 Phase 3-3)。

### 対象
- `src/events.ts` — union の型レベル整理 (event 名の文字列は**変えない** —
  wire 互換維持。 型定義を `CoreEvent | ChatEvent | CostEvent` のグループに再編)
- WS 送受信部: `attachWsServer` (server 側) と `chat-worker.ts` の bridge
- 新規: `src/shared/event-schema.ts` (zod による受信 validate)
- 文書: `spec/interface/service-schema.md` に「WS event wire 契約」節を追記

### 手順
1. `events.ts` を型グループへ再編 (event 名・payload 形状は不変。
   discriminated union の分割のみ)。 grep で全 emit/subscribe 箇所の型が
   通ることを確認。
2. WS フレームに `v: 1` フィールドを追加する。 受信側 (worker) は
   `v` 欠落 = v1 とみなす (後方互換)。 zod schema で受信 validate し、
   不明 event は **warn ログ + skip** (クラッシュさせない)。
3. 送信側で「WS に流す event の allowlist」を明示する (現状すべて流している
   なら、 その一覧を schema として固定するだけで良い。 絞り込みはしない)。
4. `spec/interface/service-schema.md` に wire 契約 (event 名一覧・payload・
   version 規約: 「payload の後方互換な追加は同 version、 破壊は v+1 で
   両対応期間を設ける」) を追記。

### 受け入れ条件
- [ ] event 名・payload が不変 (wire dump の before/after 比較を PR に記載)
- [ ] 新旧の組み合わせで疎通する: 新 server + 旧 worker / 旧 server + 新 worker
      (v フィールドの有無を許容しているか、 コードレビューで確認できる形に)
- [ ] 未知 event を受信した worker が落ちずに warn ログを出す (テストで担保)
- [ ] `spec/interface/service-schema.md` 更新、 `npm test` green
