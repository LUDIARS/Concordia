---
type: plan
title: "Phase 2 タスク指示書 — God Class 分割 (sessions / server / app / ChatPlatform)"
description: "3軸分離リファクタリングの Phase 2 実装指示。api/sessions.ts (1438行) のサブルーター分割と ChannelDirectory port 化 (V5/V6)、server.ts の軸別 bootstrap 分割、app.ts の軸別 route 登録分割、ChatPlatform の実インターフェース化と bot の repo 直読み解消 (V9/V11/V13)。URL 不変・挙動不変が絶対条件。"
service: concordia
domain: architecture
tags:
  - refactoring
  - task-instructions
  - god-class
  - bootstrap
  - chat-platform
status: planned
related:
  - README.md
  - ../refactor-3axis-architecture.md
updated: 2026-07-02
---

# Phase 2 タスク指示書 — God Class 分割

前提: Phase 1 全完了。 **全ルート URL・レスポンス形状は不変** (README 共通ルール)。
分割は「機械的移動コミット → 配線変更コミット」の 2 段で積むこと。

---

## T2-1: `api/sessions.ts` サブルーター分割 + V5/V6 解消 {#t2-1}

### 目的
1438 行の sessions router を責務別サブルーターへ分割し、 同時に
Discord repo 直依存 (V5) と `discord:`/`slack:` プレフィクスのハードコード (V6)
を契約化する (計画 §5 Phase 2a)。

### 対象
- `src/api/sessions.ts` → `src/api/sessions/` ディレクトリへ分割:

| 新ファイル | 移す route (現行の行番号目安) |
|---|---|
| `index.ts` | Hono app 合成のみ。 mount パスは現行と同一 |
| `lifecycle.ts` | POST `/` (:243), GET `/` (:393), GET `/:id` (:422), PATCH `/:id` (:452), DELETE `/:id` (:1229), heartbeat (:475), resume (:1141), abandon (:1166), fork (:938), GET `/:id/context` (:408) |
| `events.ts` | POST `/:id/event` (:513), GET `/:id/tasks` (:486), GET `/:id/pending-tasks` (:497) |
| `relay.ts` | transcript-frame (:805), inject (:1002), GET transcript (:902), fs/read・fs/list・fs/grep (:977-987), GET discord-channels (:875), inactiveTranscriptPostLog 状態 (:1410) |
| `qa.ts` | permission-request (:557), permission-response (:582), pending-question (:668), answer-question (:723), resolve (:782) |
| `title-goal.ts` | title (:609), title-suggestion (:629), request-title (:1199), goal GET/POST (:1048-1056) |
| `end.ts` | compact (:1071), relictor (:1087), session-end-done (:1317), request-stat (:1176) |

- 共有ヘルパ・deps 型は `src/api/sessions/deps.ts` に集約。

### 手順
1. **コミット 1 (機械的移動)**: 上記分割。 ロジック・依存は一切変えない。
   deps 型は現行 `SessionsRouterDeps` 相当を丸ごと `deps.ts` に移す。
2. **コミット 2 (V5)**: Discord repo 3 種 (`DiscordPendingQuestionsRepo`,
   `DiscordSessionChannelsRepo`, `DiscordConfigRepo`) への依存を
   `qa.ts` / `relay.ts` だけに閉じ、 `ChannelDirectory` interface に置換する:
   ```ts
   /** chat 層が実装しコアに注入する。コアは chat の実装を知らない */
   interface ChannelDirectory {
     pendingQuestionFor(sessionId: string): ...;
     sessionChannels(sessionId: string): ...;   // 現 GET /:id/discord-channels の中身
     // メソッドは現使用箇所から最小抽出。repo 型を再輸出しない
   }
   ```
   実装 (repo をラップ) は `src/discord/channel-directory.ts` に置き、
   `app.ts` / `server.ts` で注入する。
3. **コミット 3 (V6)**: inject の `discord:`/`slack:` source プレフィクス parse
   (:1019-1022) を `shared/inject-source.ts` の
   `parseInjectSource(s): { platform: "discord"|"slack"|null; raw: string }` に
   置換。 文字列プロトコル自体は当面維持 (wire 互換のため) — parse/format を
   1 箇所に集約するのが目的。 egress 側 (discord/slack の source 判定) も
   同じ関数を使うよう追随。

### 受け入れ条件
- [ ] ルート一覧が分割前後で完全一致 (`app.routes` を dump して diff、
      結果を PR に貼る)
- [ ] `tests/` の API テストが無修正で green
- [ ] `api/sessions/**` から `db/discord-repo` の import が 0 (V5 削除)、
      `discord:`/`slack:` リテラルが `shared/inject-source.ts` 以外に無い (V6 削除)
- [ ] 各サブルーターが 400 行未満

### やらないこと
- route の統廃合・rename。 URL は 1 文字も変えない。
- `control/*` 依存の整理 (end-session-flow 等はこのタスクでは現状維持)。

---

## T2-2: `server.ts` → 軸別 bootstrap 分割 {#t2-2}

### 目的
807 行のコンポジションルートを軸別 bootstrap に分割し (計画 §5 Phase 2b)、
`CONCORDIA_CHAT_MODE` / `CONCORDIA_COST_MODE` の骨組みを入れる。
discord-worker の重複配線 (第二コンポジションルート) も同じ bootstrap を
共用して解消する。

### 対象
- `src/server.ts` → 残すのは起動オーケストレーションのみ (~100 行目標)
- 新規: `src/bootstrap/core.ts`, `src/bootstrap/chat.ts`, `src/bootstrap/cost.ts`
- 追随: `src/discord-worker.ts` (bootstrap/chat の部分利用)

### 手順
1. **`bootstrap/core.ts`**: DB open + 全 repo 生成 (:229-266)、 サービス/seed
   (:269-371 のうち cost sampler を除く)、 sweeper/reaper/metrics/nudge/
   auto-compaction/スケジューラ (:401-630)、 eventBus 購読のコア分。
   返り値 `CoreRuntime = { repos, services, eventBus, start(), stop() }`。
2. **`bootstrap/cost.ts`**: `CostUsageTracker` + sampler timer 群 (:306-365) と
   cost cache 群。 `CostRuntime = { tracker, caches, start(), stop() }`。
   core からは「予算判定関数 (`isBlocked`)」だけを受け渡す。
3. **`bootstrap/chat.ts`**: `ChatResponder`+`Dispatcher` (:373-399)、
   discord/slack bot deps 構築 (:474-535)、 `SubsidiaryBotManager`、
   RWF init、 eventBus→dispatcher adapter (:663-701)、
   discord/slack admin (start/stop/restart closures, :114-185)。
   `ChatRuntime = { dispatcher, responder, admins, start(), stop() }`。
4. **`server.ts`**: config → `bootCore` → mode 判定 → `bootCost` / `bootChat` →
   `buildApp` → serve/WS → shutdown 逆順 stop。
   `CONCORDIA_CHAT_MODE` / `CONCORDIA_COST_MODE` (embedded|worker|off) を読み、
   **このタスクでは embedded (現状) と off のみ実装**。 worker は Phase 3。
   既存 env `CONCORDIA_DISCORD_EMBEDDED=0` は `CHAT_MODE` への後方互換
   エイリアスとして残す。
5. **`discord-worker.ts`**: repo/AdminState/DelegationService/Manager の自前
   生成 (:14-35 付近) を `bootstrap/core.ts` の repo 生成関数 +
   `bootstrap/chat.ts` の deps 構築関数の再利用に置換 (worker 固有の
   WS bridge / lease / postInject は現状維持)。

### 受け入れ条件
- [ ] `npm run dev:backend` で従来と同じ起動ログ順 (bot 起動・sweeper 開始等) に
      なる。 起動→hook 疎通→shutdown が正常 (手順を PR に記載)
- [ ] `CONCORDIA_COST_MODE=off` で cost sampler が動かず、 コア API は正常
- [ ] `CONCORDIA_CHAT_MODE=off` で bot 未起動、 コア API は正常
- [ ] `npm run discord:worker` が従来どおり動く (lease/二重防止含む)
- [ ] `server.ts` が 150 行未満、 `npm test` / `npm run build` green

### やらないこと
- worker モードの新実装 (Phase 3)。 mode の骨組みと off のみ。
- 起動順序の最適化・並列化。 順序は現状を忠実に保つ。

---

## T2-3: `app.ts` → 軸別 route 登録分割 {#t2-3}

### 目的
927 行・約 40 deps の `buildApp` を軸別 registrar に分割 (計画 §5 Phase 2c)。

### 対象
- `src/app.ts` → `buildApp` は合成のみに縮退
- 新規: `src/api/register-core.ts`, `src/api/register-chat.ts`,
  `src/api/register-cost.ts` (置き場は既存 `api/` に揃える)

### 手順
1. `AppDeps` を `CoreDeps` / `ChatDeps` / `CostDeps` に 3 分割
   (T2-2 の各 Runtime の公開面と一致させる)。
2. mount とインライン admin ハンドラを軸別 registrar へ移す:
   - core: sessions/tasks/processes/personas/reports/session-logs/skills/rules/
     library/stat/prs/work/spawn/machines/delegation/model-catalog/testing/
     harness/subsidiary + spawn/stop/reap/ws-cleanup admin (:300-586)
   - chat: chat/monitor/stream/daily + discord admin (:798-852) +
     slack admin (:855-860) + RWF admin (:680-714)
   - cost: cost-feed/cost (:267-283) + cost-budget admin (:644-665)
3. `ChatDeps` / `CostDeps` は optional にし、 未提供なら該当 route を
   mount しない (T2-2 の mode=off と整合。 未 mount 時は 404 で良い —
   ただし web frontend が叩く route は core に置かれていることを確認)。

### 受け入れ条件
- [ ] 3 mode (full / chat off / cost off) それぞれで route 一覧 dump が期待どおり
- [ ] full 構成の route 一覧が分割前と完全一致 (diff を PR に貼る)
- [ ] `tests/` API テスト無修正 green、 `app.ts` 300 行未満

---

## T2-4: `ChatPlatform` 実インターフェース化 + bot の repo 直読み解消 (V9/V11/V13) {#t2-4}

### 目的
名目だけの `platform/chat-platform.ts` を実契約にし、 両 bot が
repo 直読み + metadata/payload の inline JSON parse で core の内部表現に
依存している状態 (V9)、 ダッシュボード集計が chat 層にある状態 (V11) を解消する
(計画 §5 Phase 2d)。 これが Phase 3 chat-worker の前提 (worker が repo 直読みを
やめ WS+HTTP に寄るための穴埋め)。

### 対象
- `src/platform/chat-platform.ts` — インターフェース拡張
- `src/discord/bot.ts` (824 行) / `src/slack/bot.ts` (1022 行)
- 新規 (コア側 read-model): `src/api/read-models.ts` または既存 repo にメソッド追加

### 手順
1. **read-model の用意 (コア側)**: 両 bot が inline parse している情報を
   型付き関数で供給する:
   - `getSessionCardState(sessionId)` — status card / thread card 用
     (discord/bot.ts:178-182,555,800-803 / slack/bot.ts:195-210,978-981 の
     metadata parse を置換)
   - `getSessionPromptEvents(sessionId, opts)` — prompt/title relay 用
     (discord/bot.ts:676-683,731-738 の payload parse を置換)
   - `getMonitorSnapshot()` / `getPrQueueSnapshot()` — monitor-channel /
     pr-queue-channel の集計 (V11) をコア/コスト側関数へ移す
     (cost 系集計は既存 `cost/channel-cost.ts` 等の公開関数に寄せる)
   置き場: セッション系は `db/sessions-repo.ts` のメソッド、 集計系は
   `src/report/` or `src/pr/` の既存モジュールに追加。 **HTTP 化はしない**
   (embedded では関数呼び、 worker では既存 WS/HTTP に載せるのは T3-2)。
2. **`ChatPlatform` 拡張**: 最小の共有面を定義する
   (`name`, `stop()`, `postToSession()`, `ensureSessionSurface()`,
   `postQuestion()`, `relayFrame()` — 実装調査の上、 両 bot の egress で
   実際に共通な操作だけ。 無理な一般化はしない)。
   Discord bot の返り値を `DiscordBotHandle` から `ChatPlatform` 準拠に変更。
3. **bot の書き換え**: inline JSON parse を read-model 呼び出しに置換。
   ダッシュボード upsert 関数 (cost-channel/monitor-channel/pr-queue-channel/
   session-status-card) は「スナップショット (型付き) を受けて描画するだけ」に
   分離し、 集計部をコア側 read-model へ移す。
4. RWF・WebhookPool・working-indicator は現状維持 (既にクリーン)。

### 受け入れ条件
- [ ] `discord/**`・`slack/**` に `JSON.parse(` が原則残らない
      (残る場合は platform 固有 payload のみ。 core の metadata/event payload の
      parse が 0 であること)
- [ ] `startDiscordBot` / `startSlackBot` が共に `ChatPlatform` を返す (V13 削除)
- [ ] ダッシュボード各チャンネルの表示が変更前後で一致
      (スクリーンショット or レンダリング文字列比較を PR に記載) (V11 削除)
- [ ] depcruise: chat→core は read-model 関数の import のみ (repo 型の import 0)
      (V9 削除)
- [ ] `npm test` green (bot 系テストは read-model fake 注入に追随)

### やらないこと
- Slack への Discord 専用機能 (PR queue 等) の移植。 共有面は現状の共通部のみ。
- read-model の HTTP エンドポイント化 (T3-2 で必要になった分だけやる)。
