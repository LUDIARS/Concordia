---
type: plan
title: "プロセス分離 v2 — 影響半径 (blast radius) 最小化フォーカスでの再設計"
description: "Concordia のサブプロセス分割を「負荷分散」ではなく「影響範囲の最小化」を目的として再設計する計画。撤収済み chat-worker の失敗解剖から再挑戦の設計条件 (C1〜C5) を導出し、タスクワークフロー実行系の worker 前提実装、プロセス内隔壁 (bulkhead) 化、段階計画 S1〜S5 と数値化された rollback 基準を定義する。refactor-3axis-architecture.md Phase 3 の後継。"
service: concordia
domain: architecture
tags:
  - process-isolation
  - blast-radius
  - stability
  - chat-worker
  - task-workflow
status: active
related:
  - refactor-3axis-architecture.md
  - ../interface/service-schema.md
updated: 2026-07-12
---

# プロセス分離 v2 — 影響半径最小化フォーカスでの再設計

> 位置づけ: [`refactor-3axis-architecture.md`](refactor-3axis-architecture.md)
> (2026-07-02, 以下「3軸計画」) の Phase 3 を、**フォーカスを転換して**引き継ぐ計画。
> 3軸計画は「cost 走査の負荷がコアを塞ぐ」= **負荷分散** が主眼だった。
> 本計画は「**どれか一つの破綻が全体を落とさない**」= **影響半径の最小化** を主眼に、
> 撤収済みの chat-worker 分離を再挑戦可能な設計条件へ落とし込む。
>
> **一度失敗したことは、再挑戦しない理由にはならない。前回と今回では目的関数が違う。**
> 前回の失敗は実装品質ではなく「分割線の選定」に起因しており (§2)、
> 目的関数が変われば線の引き方が変わる。

---

## 1. 現在地 (2026-07-12 実コード確認)

3軸計画の進捗を実コードで棚卸しした結果:

| 項目 | 3軸計画での ID | 状態 |
|---|---|---|
| bootstrap 3分割 (core/chat/cost) | T2-2 | ✅ 済 (`src/bootstrap/`) |
| `api/sessions.ts` サブルーター分割 | T2-1 | ✅ 済 (`src/api/sessions/`) |
| route 登録の軸別分割 | T2-3 | ✅ 済 (`api/register-{core,chat,cost}.ts`) |
| cost-worker プロセス分離 + lease | T3-1 | ✅ 済 (`src/cost-worker.ts` + `shared/worker-lease.ts`。embedded 側は lease 検知で自動停止) |
| event-loop lag サンプラー | T0-5 | ✅ 済 (`metrics/event-loop-lag.ts`。p99>200ms で warn **ログのみ**) |
| chat-worker 昇格 | T3-2 | ❌ **撤収** (`bootstrap/chat.ts:6-8`「WS bridge 越しの interaction 遅延で不安定」) |
| event 契約の名前空間分割・版付け | T3-3 | ⬜ 未着手 |
| 周期ループの障害封じ込め | (計画外) | ⬜ 未着手 — 15 本超のループが 1 プロセス同居 |

LLM 呼び出しは既に `claude -p` の子プロセス、永続化は SQLite WAL + 起動時
`resetAllWsClients()` で crash-only の骨格はある。**未完成なのは「破綻の封じ込め」**。

## 2. 前回 (chat-worker v1) の失敗解剖

### 何が起きたか

`discord-worker` は WS bridge で core と接続し、interaction (ボタン / コマンド) の
**応答に必要なデータを core への bridge 往復で取得**していた。Discord interaction には
3 秒 ack 制約があり、bridge 遅延がここに直撃した。結果「不安定」と判定され embedded へ集約撤収。

### なぜそうなったか — 分割線が目的関数に従属していた

- **負荷分散フォーカス**の線引きは「重い処理を外に出す」。その結果、
  chat の**対話経路 (interaction → 応答描画)** の途中にプロセス境界が刺さった。
- 対話経路は latency-sensitive なので、**同期往復をまたがせた時点で構造的に負け**。
  これは実装品質の問題ではなく分割線の選定ミスであり、
  「Node/プロセス分離では無理」という結論では**ない**。

### 教訓 → 設計原則への変換

> **分割線は「落ちてよい単位」の輪郭に引く。対話経路 (同期往復) は決して横断させない。**

worker と core の接続は次の 3 種のみ許可する:

1. **SQLite 同居の読み書き** (WAL。3軸計画 §8 でも同居維持を明言済み) — 同期だがローカル
2. **非同期 event** (eventBus / WS 転送) — 取りこぼしは reconcile で救済
3. **落ちても機能縮退で済む HTTP read** — interactive path には置かない

## 3. chat-worker v2 の設計条件 (再挑戦の合格ライン)

前回の失敗モードを条件として明文化する。**この 5 条件を満たさない設計では着手しない。**

- **C1. 対話の自己完結**: gateway 接続・interaction の ack/defer・応答描画を
  **worker プロセス内で完結**させる。ack 前に core への同期往復を挟まない。
- **C2. read-model の worker 側保持**: 応答描画データ (`chatReadModel` 相当) は
  worker が **SQLite を直接読んで**構築する (WAL 同居なので可能)。
  v1 の bridge 往復を「速い RPC」に置き換えるのではなく、**往復そのものを無くす**。
  core への HTTP は副作用系 (inject / spawn 依頼) のみとし、ack 後の非同期処理に置く。
- **C3. 双方向の縮退動作**: core 死 → chat は閲覧 + 「core 停止中」明示 + 操作キューイング。
  chat 死 → core のセッション協調・hooks 受信は無影響
  (現 embedded では bot の例外がプロセス全体を巻き込みうる)。
- **C4. 実績機構の流用**: 二重起動防止は `shared/worker-lease.ts` (cost-worker で実証済み)、
  event 取りこぼしは旧 discord-worker の 5 分周期 reconcile パターンを踏襲。
- **C5. rollback 基準の事前数値化**: 移行フラグ (`CONCORDIA_CHAT_MODE=worker`) 併用期間中、
  (a) interaction ack 成功率 (3 秒以内 ack 率) と (b) core の event-loop lag p99 を計測し、
  **ack 成功率が embedded 比で劣化したら即 embedded へ戻す**。
  v1 は定量基準なしで「不安定」判定になった。今回は撤退条件も前進条件も数値で持つ。

## 4. タスクワークフロー実行系 — 最初から worker 前提で書く

新規に増えるタスクワークフロー (`CONCORDIA_CC_WORKFLOW` 系) は、chat と違い
**分離向きの条件が全部そろっている**: (a) 今後の主要な負荷増加源、
(b) SQLite のタスクキュー経由で疎結合にできる、(c) 対話レイテンシ要件がない。

- エントリを `src/workflow-worker.ts` とし、cost-worker と同じ
  「lease + heartbeat + embedded フォールバック + 本体側の lease 検知で自動停止」型にする。
- キュー消費は at-least-once (取得時に lease 列で claim、クラッシュ時は TTL で解放)。
- 後から剥がすより、新規のうちに worker 境界で書く方が桁違いに安い。
  **暴走・クラッシュしてもセッション協調の中枢が無傷**という影響半径を最初から確保する。

## 5. プロセス内隔壁 (bulkhead) — 分割と独立に、先にやる

分割してもしなくても効く封じ込め。工数が小さく、即着手できる。

1. **周期ループの障害封じ込め**: `bootstrap/core.ts` の `startPostListenBackground`
   (`trackPostListenHandle` 管理下) に 15 本超の周期ループが同居している。
   共通ラッパを噛ませ「連続 N 回失敗 → そのループのみ自動停止 + 通知 + 停止中ループ名を露出」。
   現状は tick 内 try/catch がある所も「壊れ続けるループが warn を吐き続けるだけ」で誰も気づかず、
   try/catch の無い非同期経路の未捕捉例外は**プロセス全体を道連れ**にしうる。
2. **event-loop lag 警告の通知配線**: p99>200ms は現在 warn ログ止まり
   (`metrics/event-loop-lag.ts`)。chat / Excubitor へ配線し、
   「何かが塞いでいる」を人間とエージェントが即座に知れるようにする。
   これは §7 の S3・S4 の判断材料 (どこを次に切り出すか) の収集経路も兼ねる。
3. WS の per-socket `error` ハンドラ欠落 (`api/ws.ts`) — **「1 ソケットエラーで全プロセス死」の
   典型例**であり、本計画の目的に直結する最優先の隔壁。
   Discord gateway の瞬断による恒久停止 (`discord/bot.ts`) も同系統。

## 6. 障害半径マトリクス (目標形)

| 死ぬもの | 影響 (目標) | 現状 (embedded) |
|---|---|---|
| core (11111) | サービス死 (唯一の全損点)。Excubitor 再起動 + SQLite WAL で復旧 | 同左 = 全機能死 |
| chat-worker | UI / 通知停止のみ。協調・hooks 無影響。復旧後 reconcile | **bot 例外がプロセス全体を巻き込みうる** |
| workflow-worker | ワークフロー消化の遅延のみ。キューは SQLite に残存 | (embedded 実装だと core と運命共同体) |
| cost-worker | レポート欠測のみ (実証済み) | ✅ 分離済み |
| 周期ループ 1 本 | そのループのみ停止 + 通知 | warn 連発 or 最悪プロセス死 |

## 7. 段階計画

| 段 | 内容 | 依存 | 規模 |
|---|---|---|---|
| S1 | 隔壁化 (§5): ループ封じ込め + lag 通知配線 + WS error ハンドラ + gateway 自動再接続 | なし | S〜M |
| S2 | workflow-worker: タスクワークフロー実行系を worker 前提で実装 (§4) | worker-lease (既存) | M |
| S3 | 計測基盤: interaction ack 成功率の計測を embedded bot に仕込む (C5 の比較基準づくり) | なし | S |
| S4 | chat-worker v2: C1〜C5 準拠で再分離。`CHAT_MODE=worker` フラグ併用 → 数値判定 | S3、3軸計画 T2-4 (read-model 整備) | L |
| S5 | event 契約の名前空間分割と版付け (3軸計画 T3-3) — S4 と並走可 | S4 着手 | M |

### 実装進捗 (2026-07-12)

- ✅ S1: 共通 loop bulkhead、`/health.halted_loops`、lag cooldown 通知、WS socket error、gateway restart。
- ✅ S2: `workflow-worker.ts`。既存 `delegation_runs(status=queued)` を producer/consumer 境界に再利用し、独立 lease + embedded fallback を実装。
- ✅ S3: Discord interaction の replied/deferred を 3 秒まで観測し、`discord.interaction.ack` metric に `process_mode` / `within_3s` を記録。
- ✅ S4 実装: `chat-worker.ts` は SQLite read-model を直接保持し、WS は版付き非同期 event のみ。独立 lease、5 分 reconcile、core mutation durable outbox、embedded fallback を実装。
- ⏳ S4 rollout 判定: 本番相当で embedded/worker の ack 成功率と event-loop lag p99 を比較し、C5 の前進/rollback 判定を行う。実 DB の破壊操作と同様、この切替は人間の最終確認後。
- ⬜ S5: event 名の namespace 再編は未着手 (wire version `v=1` と zod validation は既存実装を利用)。

- S1 は即着手可。S2 はタスクワークフロー実装と同時に行う (後付けにしない)。
- **S4 だけが「再挑戦」であり、S3 の計測なしには始めない。**

## 8. 案の比較 (decision-metrics)

| 案 | (1) AI 負荷 | (2) 工数 | (3) 解決度 | (4) 一致度 | 採用? |
|----|---|---|---|---|---|
| A. 隔壁化のみ (S1) | 2 | 約 150-250 行 | 3 | 5 | ◎ 即実施 |
| B. A + workflow-worker (S2) | 2 | 約 300-400 行 (lease 流用) | 4 | 5 | ◎ |
| C. A + B + chat-worker v2 (S3→S4) | 3 | 約 800-1,200 行 (read-model 移設含む) | 5 | 5 | ◎ 段階実施 |
| D. 全面マイクロサービス化 (DB 分割含む) | 5 | 数千行 + wire 契約再設計 | 3 | 2 | × |

- D が ×: 影響半径は C で十分に絞れる。DB 分割は 3軸計画 §8 の非目標を維持
  (WAL 同居は C2 の前提でもある)。
- C は「一度失敗した」案だが、失敗要因 (対話経路の横断) を C1/C2 で構造的に排除し、
  C5 で撤退条件を数値化している。**v1 とは別物の設計**である。

## 9. 非目標

- DB 分割・npm workspaces 化はしない (3軸計画 §8 踏襲)。
- HTTP ルート URL / hook 契約の変更はしない。
- lock 導入はしない (Concordia 設計指針)。
- **負荷分散それ自体は目的にしない。** lag が問題になったら、
  §5-2 の計測が出す証拠で次の分離対象を決める。推測で分離しない。
