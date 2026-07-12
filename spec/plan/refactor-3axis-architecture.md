---
type: plan
title: "3軸分離リファクタリング — Cc 安定化と運用継続のためのアーキテクチャ再編"
description: "肥大化した Concordia を「AI協働コア / チャット連携+RWF / コストリポーター」の 3 機能軸に分離するリファクタリング計画。God Class (server.ts / app.ts / api/sessions.ts / 両 bot) の分割、軸間結合の切断、cost 走査とチャットリレーのプロセス分離により、コア (セッション協調) が周辺機能の障害・負荷に巻き込まれない構造にする。Phase 0〜4 の段階計画と受け入れ条件を定義する。"
service: concordia
domain: architecture
tags:
  - typescript
  - refactoring
  - architecture
  - stability
  - process-isolation
  - modularity
status: planned
related:
  - tasks/README.md
  - process-isolation-v2.md
  - p4-structural-hardening-2026-07-13.md
  - ../feature/subsidiary-delegation.md
  - ../feature/delegation.md
  - ../feature/reaction-workflow.md
  - ../feature/slack-platform.md
  - ../feature/multi-provider.md
  - ../interface/service-schema.md
updated: 2026-07-02
---

# 3軸分離リファクタリング — Cc 安定化と運用継続のためのアーキテクチャ再編

> Concordia は src 42k 行・SQLite 54 テーブル・単一プロセスに成長し、
> 「協働が本質でない」周辺機能 (cost 集計など) の負荷・障害が
> 本質であるセッション協調を巻き込んで落とす構図が常態化している。
> 本計画は機能を **3 つの軸** に分離し、 軸間の依存を契約 (event / HTTP / port)
> に限定することで、 **コアが単独で生き残る** 構造を作る。

---

## 1. 背景 — なぜ今やるか

直近の安定化対応 (#255, #257, #259, #263) はいずれも対症療法であり、 根本原因は
**軸の混在** にある:

| 事象 | 対症 | 構造的原因 |
|---|---|---|
| cost 窓集計 reader がイベントループを長時間ブロック | memo 化 (#255) | cost の JSONL 全走査が **コアと同一プロセス** で走る |
| channel-cost reader で残り 16 秒ブロック | tail/増分読み (#257) | 同上 |
| self-restart の supervisor 二重化 → EADDRINUSE クラッシュループ | in-place 化 (#259) | 全機能が 1 プロセスに同居し再起動の影響半径が最大 |
| spawn 不安定 / テスト交通混乱 | 安定化バッチ (#263) | chat 層と core 層の責務境界が無い |

cost が重くなるとセッション heartbeat・inject・sweeper まで遅延する。
Discord gateway が詰まると HTTP API が巻き添えになる (embedded 時)。
**周辺機能の品質問題が、 サービス全体の可用性問題に化ける** のが現状である。

なお、 分離の成功前例は既にある: observability は **Excubitor** (port 17332)
へサービスごと切り出し済み (`server.ts` 内コメント参照)。 本計画はその路線を
プロセス/モジュール境界のレベルで社内に適用するもの。

---

## 2. 3 つの機能軸と現状モジュールのマッピング

### 軸 A — AI 協働コア (Concordia の本質)

セッション協調・認識・記録。 これが死ぬと Concordia が死ぬ。

| サブ機能 | モジュール |
|---|---|
| セッションライフサイクル | `api/sessions.ts`, `db/sessions-repo.ts`, `sweeper.ts`, `control/` (reaper / compaction / stalled-nudge / end-session-flow / spawner) |
| テスト・ブランチ衝突検知 | `testing/branch-watch.ts`, `testing/notify.ts`, `db/testing-claims-repo.ts`, `control/ws-cleanup.ts`, `work/repo-scan.ts` |
| ハーネス機構 | `harness/` (predicates / session-gate / prompt-intent / local-prompt-analyzer / prompt-research), `api/harness-session.ts` |
| モデル抽象化 | `providers/` (AgentProvider registry), `model-catalog/`, `rules/claude-runner.ts` |
| Delegation | `delegation/service.ts`, `api/delegation.ts`, `db/delegation-repo.ts` |
| 本社子会社 | `subsidiary/` (guard / gate / manager / budget), `api/subsidiary.ts` |
| その他コア | `pr/`, `personas/`, `report/`, `mcp/core-server.ts`, `events.ts`, `dispatcher.ts` |

### 軸 B — チャット連携 + RWF (操作 UI・可視化)

Discord/Slack はコアへの **入出力チャネル**。 死んでもセッション協調は続く。

| サブ機能 | モジュール |
|---|---|
| Discord | `discord/` 一式, `db/discord-repo.ts`, `discord-worker.ts` |
| Slack | `slack/` 一式 |
| RWF (reaction workflow) | `platform/reaction-workflow.ts`, `reaction-workflow-loader.ts` |
| 共有チャット基盤 | `platform/chat-platform.ts`, `working-indicator.ts`, `chat/` (responder / render), `chat-actionable.ts` |

### 軸 C — コストリポーター (協働が本質でない LLM データロガー)

JSONL 走査・予算集計・レポート描画。 遅延・欠測は許容できるがコアを止めてはならない。

| サブ機能 | モジュール |
|---|---|
| 使用量読み取り | `cost/log-usage.ts` + 各 cache (session-usage / windowed / channel-cost / log-totals) |
| 予算・サンプリング | `cost/usage-tracker.ts`, usage/limit-sampler, `db/cost-*-repo.ts` |
| レポート | `cost/cost-report.ts`, `org-cost.ts`, `channel-cost.ts`, `session-cost.ts` |
| 外部フィード | `cost/cost-feed.ts`, `one-shot-recorder.ts`, `api/cost.ts`, `api/cost-feed.ts` |

**軸をまたぐ描画コンポーネント** (cost-channel.ts / monitor-channel.ts /
cost-canvas.ts / session-status-card.ts) は「B が C の読み取り API を呼ぶ」形に
整理する (§4 依存規則)。

---

## 3. 現状の結合違反インベントリ (切断対象)

リファクタの作業単位はこの表の 1 行 = 1 PR 程度を目安にする。

| # | 違反 | 場所 | 方向 |
|---|---|---|---|
| V1 | cost ↔ subsidiary **循環依存** | `cost/org-cost.ts:17` → `subsidiary/budget.ts` / `subsidiary/budget.ts:17-18` → `cost/log-usage.ts` | C↔A |
| V2 | `RunClaudeFn` 型が `subsidiary/guard.ts` 住まいで harness 一式が import | `harness/prompt-intent.ts:2` ほか | A内ねじれ |
| V3 | Slack が Discord モジュールを import | `slack/render.ts:4` → `discord/egress-filters.js`, `slack/bot.ts:18` → `discord/formatter.js` | B内ねじれ |
| V4 | subsidiary/manager が Discord bot を直 import | `subsidiary/manager.ts:10-12` | A→B |
| V5 | コアの sessions router が Discord repo 3 種を必須依存に | `api/sessions.ts:22-27` (使用: `:813`, `:875-879`) | A→B |
| V6 | sessions router に `discord:`/`slack:` source プレフィクスがハードコード | `api/sessions.ts:1019-1022` | A→B |
| V7 | 両 bot が `runClaude` (LLM ランナー) を直 import | `discord/bot.ts:25`, `slack/bot.ts:53` | B→A |
| V8 | Discord bot が `control/repin-session` を直 import | `discord/bot.ts:22` | B→A |
| V9 | 両 bot が repo を直読みし `session.metadata` / event `payload` の JSON を inline パース | `discord/bot.ts:178-182,555,676-683,800-803`, `slack/bot.ts:195-210,331-333,978-981` | B→A |
| V10 | cost router が Discord channel repo に依存 | `app.ts:271-272` | C→B |
| V11 | Discord ダッシュボードが業務集計 (cost/PR/task) を chat 層内で実施 | `discord/monitor-channel.ts:4-7`, `cost-channel.ts:6-11` ほか | B→A/C |
| V12 | `events.ts` の event union が全軸混載のまま **cross-process wire 契約** 化 | `discord-worker.ts:80` (WS 再 emit) | 全軸 |
| V13 | `chat-platform.ts` が名目インターフェース (Discord 非準拠、共有メソッド無し) | `platform/chat-platform.ts` | B |
| V14 | sweeper (コア) が dispatcher/chat へ直接到達 | `sweeper.ts:67-79` | A→B |

---

## 4. 目標アーキテクチャ

### 4.1 依存規則 (最重要・これだけは守る)

```
軸A (core)  ← 何にも依存されない側。B/C を import しない。
軸B (chat)  → A へは「型付き event 購読 + HTTP API + 注入 port」経由のみ。
軸C (cost)  → A の repo 読み取りは可、A/B の import は不可。
軸B → 軸C  → 読み取り API (collectCostReport 等の関数契約) のみ。逆流禁止。
共有 (shared/) → どの軸からも import 可。どの軸も import しない。
```

- 逆方向が必要な箇所は **port (関数型 deps) 注入** にする。 手本は既にある:
  `ReactionWorkflowRunner` は `runHeadless` / `emitInject` を注入で受けており
  discord.js / core を一切 import しない。 **この形を標準形とする**。
- 規則は目視でなく **CI で機械的に強制** する (dependency-cruiser。 既存違反は
  許容リストに載せ、 Phase ごとにゼロへ ratchet)。

### 4.2 プロセストポロジ (最終形)

```
┌────────────────────────────┐   WS (typed events) + HTTP   ┌──────────────────┐
│ concordia-core (11111)     │◄────────────────────────────►│ chat-worker      │
│  sessions / harness /      │                              │  Discord + Slack │
│  delegation / subsidiary / │   SQLite (cost_* tables)     │  + RWF           │
│  testing / pr / sweeper    │◄────────────────────────────►└──────────────────┘
│  ※ bot も cost 走査も無し  │                              ┌──────────────────┐
└────────────────────────────┘                              │ cost-worker      │
        ▲ hooks (HTTP)                                      │  JSONL 走査/     │
   Claude Code / Codex / Gemini                             │  sampler / 予算  │
                                                            └──────────────────┘
```

- **chat-worker**: 既存 `discord-worker.ts` (lease 機構つき) を土台に Slack も
  収容して昇格。 embedded bot は撤去 (移行期はフラグで残す)。
- **cost-worker**: JSONL 走査・sampler をコアから追い出す。 結果は既存の
  `cost_*` テーブルに書き、 コアとチャットは **テーブル/HTTP を読むだけ**。
  イベントループブロック問題 (#255/#257) はプロセス境界で根治する。
- コアに残る cost 接点は「予算ブロック判定 (`isBlocked`)」のみで、 これは
  cost-worker が書いた集計行の読み取りで済む。
- worker が落ちても: chat 死 → 協調は継続 (UI が止まるだけ)。 cost 死 →
  レポート欠測のみ。 **コア死のみがサービス死**、 という影響半径にする。

### 4.3 単一プロセス運用の維持 (運用継続の要件)

3 プロセス強制はしない。 各軸の bootstrap を分離した上で、 デフォルトは
従来どおり 1 プロセス相乗り・環境変数で切り離し可能とする:

```
CONCORDIA_CHAT_MODE=embedded|worker|off   (default: embedded → 将来 worker)
CONCORDIA_COST_MODE=embedded|worker|off   (default: embedded → 将来 worker)
```

これにより開発機は今までの `npm run dev` のまま、 本番相当だけ worker 分離、
という段階運用ができる。

---

## 5. フェーズ計画

> 実装タスクへの分解は [`tasks/README.md`](tasks/README.md) (Codex 向け指示書)。

各フェーズは独立にマージ・リリース可能。 **HTTP ルート URL と hook 契約は
全フェーズで不変** (hook / MCP / web が同じ URL を叩き続けられること)。

### Phase 0 — 安全網 (準備。 挙動変更なし)

1. **依存境界 lint 導入**: dependency-cruiser を追加し §3 の V1〜V14 を
   許容リスト化。 CI (`npm run lint`) で新規違反をブロック。
2. **触る場所のテスト補充**: `providers/` (0 本)、 `testing/` (0 本)、
   `delegation/` (1 本のみ) にユニットテストを先行追加。
   ※ cost / harness / subsidiary は既に厚い (16/20, 5/5, 6/7) ので不要。
3. **イベントループ lag 計測**: `metrics/` に event-loop delay サンプラーを
   追加し、 分離の効果を数値で確認できるようにする (#255 系の再発検知も兼ねる)。

受け入れ条件: CI に boundary チェックが載り、 violation 数がダッシュボード化
(または lint 出力) で追える。

### Phase 1 — 結合の機械的切断 (小 PR の束。 挙動変更なし)

| 対象 | 作業 |
|---|---|
| V1 | `readSubsidiaryId` (純粋な JSON parse) を `shared/` へ移動 → 循環解消 |
| V2 | `RunClaudeFn` 型を `rules/claude-runner.ts` (または `shared/types.ts`) へ移動 |
| V3 | `discord/formatter.ts` `discord/egress-filters.ts` を `platform/` へ移動 (実体は既に platform 中立) |
| V4 | `subsidiary/manager.ts` に `BotStarter` port を導入し、 `startDiscordBot` は server.ts から注入 |
| V7/V8 | 両 bot の `runClaude` / `repin-session` を deps 注入化 (RWF と同形) |
| V10 | cost router の `discordChannels` 依存を `resolveChannelName(sessionId)` 関数注入に置換 |
| V14 | sweeper → dispatcher 直呼びを eventBus 購読へ (server.ts の既存 adapter に寄せる) |

受け入れ条件: dependency-cruiser の許容リストから該当行を削除して green。
vitest / tsc 全 green。 挙動差ゼロ (リレー・レポート出力のスナップショット比較)。

### Phase 2 — God Class 分割

**2a. `api/sessions.ts` (1438 行) → サブルーター分割**

```
api/sessions/
├── index.ts        # 合成のみ (URL 不変)
├── lifecycle.ts    # create/list/get/patch/delete/heartbeat/resume/abandon/fork
├── events.ts       # event/tasks/pending-tasks
├── relay.ts        # transcript-frame/inject/transcript  ← chat 向け面
├── qa.ts           # permission-request/response, pending-question/answer
├── title-goal.ts   # title/title-suggestion/goal/request-title
└── end.ts          # compact/relictor/session-end-done/request-stat
```

- V5: Discord repo 3 依存は `qa.ts` / `relay.ts` に閉じ込めた上で、
  `ChannelDirectory` port (interface) 化して chat 層から実装を注入する。
- V6: `discord:` / `slack:` プレフィクス parse を `InjectSource` 型
  (`{platform, authorLabel}`) に置換し、 プロトコルを `shared/` の契約にする。

**2b. `server.ts` (807 行) → 軸別 bootstrap**

```
src/bootstrap/
├── core.ts   # repos + services + sweeper/reaper/schedulers → CoreRuntime
├── chat.ts   # discord/slack/RWF/subsidiary-bots → ChatRuntime
└── cost.ts   # tracker + samplers + caches → CostRuntime
```

各 runtime は `{ start(), stop() }` を持ち、 `server.ts` は
「config 読み → core 起動 → mode に応じ chat/cost 起動 → buildApp」 の
50 行程度のオーケストレーターに縮退。 `discord-worker.ts` の重複配線
(第二コンポジションルート問題) も `bootstrap/chat.ts` を共用して解消する。

**2c. `app.ts` (927 行) → 軸別 route 登録**

`AppDeps` を `CoreDeps` / `ChatDeps` / `CostDeps` に 3 分割し、
`registerCoreRoutes(app, core)` 等に分ける。 inline の admin ハンドラ群
(spawn/stop/discord admin/cost-budget 等) は各軸の router ファイルへ移す。

**2d. `ChatPlatform` を実インターフェース化 (V9/V11/V13)**

- 共通面 (`postToSession` / `ensureSessionSurface` / `postQuestion` /
  `relayFrame` / `stop`) を定義し、 Discord も準拠させる (現状 Slack のみ)。
- bot 内の `session.metadata` / event `payload` inline JSON parse を廃し、
  コア側に read-model (`getSessionCardState()` 等の関数) を用意して
  **型付きデータを供給**する。 ダッシュボード集計 (monitor/cost/pr-queue) の
  業務ロジックはコア/コスト側の関数に移し、 chat 層は描画だけにする。
- `reaction-workflow.ts` (1073 行) は結合的には既にクリーンなので分割は
  低優先。 やるなら `planWorkflow` のプロンプト表 (絵文字→prompt) を
  データファイル分離するに留める (ハードコードされた絶対パス・他サービス URL
  は config 化)。

受け入れ条件: 全ルート URL 不変 (tests/ の API テストで担保)。
sessions.ts / server.ts / app.ts / 両 bot がそれぞれ 400 行未満。

### Phase 3 — プロセス分離 (安定化の本丸)

> **更新 (2026-07-12)**: 3-1 (cost-worker) は完了。 3-2 (chat-worker) は
> **一度実装したが撤収した** (`bootstrap/chat.ts` 参照 — WS bridge 越しの
> interaction 遅延で不安定)。 失敗要因は「負荷分散フォーカスの分割線が
> Discord interaction の対話経路 (3 秒 ack) を横断したこと」であり、
> 実装品質ではなく分割線の選定にある。 **これは再挑戦しない理由にはならない。**
> フォーカスを「負荷分散」から「**影響半径 (blast radius) の最小化**」へ
> 転換した後継計画 [`process-isolation-v2.md`](process-isolation-v2.md) で、
> 再挑戦の設計条件 (C1〜C5) と数値化された rollback 基準を定義した。
> Phase 3 の残り (3-2 / 3-3) は以後そちらを正本とする。
>
> **実装追記 (2026-07-12)**: 後継計画 S1〜S4 のコード実装を完了。chat-worker v2 は
> SQLite read-model 直読・非同期 WS event・durable mutation outbox により、v1 の同期往復を
> 対話経路から除去した。`CONCORDIA_CHAT_MODE=worker` の本番切替は ack 成功率比較後に行う。

1. **cost-worker 切り出し**: `bootstrap/cost.ts` を `src/cost-worker.ts`
   エントリで起動可能に。 JSONL 走査・sampler は worker 内のみ。 コアは
   `cost_*` テーブル読み + 予算判定のみ。 `COST_MODE=worker` で有効化。
2. **chat-worker 昇格**: `discord-worker.ts` を `src/chat-worker.ts` に改め
   Slack も収容。 既存の relay-owner lease を chat 全体の lease に拡張
   (embedded との二重リレー防止はそのまま流用)。
3. **event 契約の整備 (V12)**: `ConcordiaEvent` union を
   `core.*` / `chat.*` / `cost.*` に名前空間分割し、 WS で流す部分は
   **wire 契約としてバージョン付け** (`spec/interface/service-schema.md` に正本を追記)。
   worker は WS + HTTP のみでコアと通信し、 repo 直読みを段階的に縮小する
   (SQLite 同居は当面許容 — WAL なので実害は薄い)。
4. 運用面: `dev-process.md` の `concordia.processes` に worker 2 種を追記し、
   SessionStart 自動起動の対象にする。 クラッシュ時はコア非依存で個別再起動。

受け入れ条件: `COST_MODE=worker` で event-loop lag p99 が embedded 比で
有意に低下 (Phase 0 の計測で判定)。 chat-worker kill → コア API・hook が
無影響で応答し続けることを統合テストで確認。

### Phase 4 — ディレクトリ再編 (任意・最後)

境界が lint で守られた後にのみ実施 (見た目の移動を先にやると diff が汚れて
Phase 1-3 のレビューが不能になるため最後)。

```
src/
├── core/       # sessions, harness, providers, delegation, subsidiary, testing, control, pr, ...
├── chat/       # discord, slack, platform(RWF), responder
├── cost/
├── shared/
└── bootstrap/  + server.ts / chat-worker.ts / cost-worker.ts
```

npm workspaces 化はこの時点でも **やらない** (単一リポ・単一 node_modules の
運用簡便性を優先。 #261 の junction 問題の再来を避ける)。

---

## 6. Cc 安定化への直接効果 (対応表)

| 不安定要因 | 対応 |
|---|---|
| cost 走査によるイベントループブロック (#255/#257) | Phase 3-1: プロセス分離で構造的に不可能化 |
| Discord gateway 混雑がコアを巻き込む | Phase 3-2: chat-worker 分離 (lease 済み機構の昇格) |
| 再起動の影響半径が全機能 (#259 系) | Phase 2b/3: 軸別 runtime + 個別プロセス再起動 |
| 障害調査困難 (どの軸のログか不明) | bootstrap 分割で logger の軸プレフィクス統一 |
| 修正の副作用が軸を越えて波及 | Phase 0/1: 依存 lint で越境 import を CI ブロック |
| コア変更時のテスト空白 (providers/testing 0 本) | Phase 0-2: 先行テスト補充 |

## 7. 成功指標

- dependency-cruiser 違反: 14 → 0 (Phase 1-2 完了時)
- 最大ファイル行数: 1438 → 400 未満 (Phase 2)
- event-loop lag p99 (コアプロセス): Phase 0 計測値比で恒常的に改善 (Phase 3)
- chat-worker / cost-worker を kill してもコア API の 5xx ゼロ (Phase 3)
- `npm run dev` の開発体験は不変 (全フェーズ)

## 8. 非目標・やらないこと

- **マイクロサービス化・DB 分割はしない**。 SQLite 1 ファイル + WAL 同居は維持
  (Excubitor のような別サービス切り出しは、 本計画完了後に必要なら判断)。
- HTTP API / hook 契約の変更はしない (バージョン付けは event WS のみ)。
- RWF エンジンの再設計はしない (既にクリーン。 config 外出しのみ)。
- lock 導入はしない (「lock しない」設計指針は不変)。

## 9. リスクと対策

| リスク | 対策 |
|---|---|
| 移動系 refactor と挙動変更の混在でレビュー不能 | 1 PR = §3 の 1 違反 or 1 分割単位。 機械的移動 PR にロジック変更を混ぜない |
| worker 分離後の event 取りこぼし | 既存 discord-worker の reconcile (5 分周期の救済) パターンを chat/cost 両 worker に踏襲 |
| embedded/worker の二重起動 | 既存 relay-owner lease をそのまま拡張 (実績あり) |
| wire 契約 (event union) の暗黙破壊 | Phase 3-3 でバージョン付け + `service-schema.md` 正本化。 zod schema で受信側 validate |
| 分割中の spec 乖離 | 各 Phase 完了時に `spec/` 該当文書の `related`/構成を更新 (AIFormat 規約) |
