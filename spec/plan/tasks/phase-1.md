---
type: plan
title: "Phase 1 タスク指示書 — 結合の機械的切断 (V1〜V14 の import レベル解消)"
description: "3軸分離リファクタリングの Phase 1 実装指示。cost↔subsidiary 循環依存の解消、RunClaudeFn 型の移設、chat 共有ユーティリティの platform/ 移動、BotStarter port 導入、両 bot への runClaude/repin 注入化、cost router の Discord repo 依存除去、sweeper の eventBus 化。全タスク挙動変更なし・1 タスク = 1 PR。"
service: concordia
domain: architecture
tags:
  - refactoring
  - task-instructions
  - decoupling
  - dependency-injection
status: planned
related:
  - README.md
  - ../refactor-3axis-architecture.md
updated: 2026-07-02
---

# Phase 1 タスク指示書 — 結合の機械的切断

前提: T0-1 (dependency-cruiser) 完了。 各タスク完了時に **許容リストから
該当 V 番号の行を削除**し、 `npm run depcruise` が green のままであることが
受け入れ条件に含まれる。 全タスク挙動変更なし。

---

## T1-1: V1 — cost↔subsidiary 循環依存の解消 {#t1-1}

### 目的
`cost/org-cost.ts:17` → `subsidiary/budget.ts` と
`subsidiary/budget.ts:17-18` → `cost/log-usage.ts`+`usage-tracker.ts` の相互依存を切る。

### 対象
- `src/subsidiary/budget.ts` — `readSubsidiaryId(metadata)` (純粋な JSON parse 関数)
- `src/cost/org-cost.ts` — 上記の import 元
- 新規: `src/shared/subsidiary-id.ts` (または `shared/types.ts` 追記)

### 手順
1. `readSubsidiaryId` を `src/shared/subsidiary-id.ts` へ移動 (実装は無変更)。
2. `subsidiary/budget.ts` と `cost/org-cost.ts` の両方を新パスへ向ける。
   旧 export は残さない (re-export の踏み跡を作らない)。
3. import 追随はリポジトリ全体を grep して漏れなく (`readSubsidiaryId` で検索)。

### 受け入れ条件
- [ ] `cost/**` → `subsidiary/**` の import が 0 (depcruise 許容リストから V1 削除)
- [ ] `npm test` green (subsidiary/budget, cost/org-cost の既存テストが無修正
      または import パス追随のみで通る)

### やらないこと
- `subsidiary/budget.ts` → `cost/log-usage.ts` 方向の解消 (これは計画 §4.1 で
  「C の読み取り関数契約」として合法。 触らない)。

---

## T1-2: V2 — `RunClaudeFn` 型の移設 {#t1-2}

### 目的
harness 一式 (`prompt-intent.ts:2`, `local-prompt-analyzer.ts:2`,
`api/harness-session.ts:26`, `api/subsidiary.ts`) が `subsidiary/guard.ts:49` の
型を逆参照しているねじれを解消。

### 対象
- `src/subsidiary/guard.ts` — `RunClaudeFn` 型定義の現住所
- 移設先: `src/rules/claude-runner.ts` (実装 `runClaude` と同居させる)

### 手順
1. `RunClaudeFn` を `rules/claude-runner.ts` に定義し、 `runClaude` の型注釈が
   これに適合することを確認 (`const runClaude: RunClaudeFn` にできるなら尚可、
   シグネチャ変更は不可)。
2. `subsidiary/guard.ts` は新住所から import する側に変更。
3. 全 import 元 (`RunClaudeFn` で grep) を追随。

### 受け入れ条件
- [ ] `harness/**` → `subsidiary/**` の import が 0
- [ ] `npm test` / `npm run lint` / `npm run depcruise` green (V2 削除)

---

## T1-3: V3 — formatter / egress-filters を `platform/` へ移動 {#t1-3}

### 目的
`slack/render.ts:4` → `discord/egress-filters.js`、 `slack/bot.ts:18` →
`discord/formatter.js` の cross-platform import を解消。 実体は platform 中立
(chat 共有ユーティリティ) なのに置き場が `discord/` なのが原因。

### 対象
- `src/discord/formatter.ts` → `src/platform/formatter.ts`
- `src/discord/egress-filters.ts` → `src/platform/egress-filters.ts`
- co-located テスト (`formatter.test.ts`, `egress-filters.test.ts`) も同時移動

### 手順
1. `git mv` で 2 ファイル + テストを移動 (履歴追跡のため rename として)。
2. import 元を全て追随 (discord 側・slack 側の両方。 grep:
   `egress-filters`, `formatter.js`)。
3. 移動先で discord.js 型への依存が残っていないか確認。 もし
   `formatter.ts` 内に discord.js import があれば、 その関数だけ
   `discord/` に残し (ファイル分割)、 中立部分のみ移動する。

### 受け入れ条件
- [ ] `slack/**` → `discord/**` の import が 0 (V3 削除)
- [ ] `platform/**` から discord.js / @slack への import が増えていない
- [ ] `npm test` green (テストは移動のみ・assert 無変更)

---

## T1-4: V4 — `SubsidiaryBotManager` に `BotStarter` port 導入 {#t1-4}

### 目的
`subsidiary/manager.ts:10-12` が `discord/bot.js` (`startDiscordBot`,
`DiscordBotDeps`) を直 import している A→B 違反を解消。 domain lifecycle
manager は transport 実装を知らない状態にする。

### 対象
- `src/subsidiary/manager.ts`
- 配線元: `src/server.ts` と `src/discord-worker.ts` (両方が manager を組み立てる)

### 手順
1. `subsidiary/manager.ts` 内に最小の port 型を定義する:
   `type SubsidiaryBotStarter = (env: <managerが渡す設定>, deps: <必要最小>) => Promise<{ stop(): Promise<void> }>`。
   型の中身は現在 `startDiscordBot` に渡している引数から **manager が実際に
   使っているものだけ** を抽出して決める (DiscordBotDeps 全体を写さない)。
2. `SubsidiaryBotManager` のコンストラクタ引数に starter を追加し、
   内部の直 import を全廃。
3. `server.ts` / `discord-worker.ts` で `startDiscordBot` をラップした
   starter を注入。
4. `manager.test.ts` は fake starter 注入に書き換え (assert の意味は不変)。

### 受け入れ条件
- [ ] `subsidiary/**` → `discord/**` の import が 0 (V4 削除)
- [ ] embedded / worker 両モードで subsidiary bot が従来どおり起動する
      (起動ログで確認、 確認手順を PR に記載)
- [ ] `npm test` green

---

## T1-5: V7/V8 — 両 bot の `runClaude` / `repinSession` 注入化 {#t1-5}

### 目的
`discord/bot.ts:25` / `slack/bot.ts:53` の `rules/claude-runner.js` 直 import
(RWF runner 構築用) と、 `discord/bot.ts:22` の `control/repin-session.js`
直 import を deps 注入に変える。 手本は RWF 本体
(`platform/reaction-workflow.ts` — `runHeadless` を deps で受けている)。

### 対象
- `src/discord/bot.ts` — `DiscordBotDeps` に `runHeadless: RunClaudeFn` と
  `repinSession: (sessionId: string) => Promise<void>` (実シグネチャに合わせる) を追加
- `src/slack/bot.ts` — 同様に `runHeadless` を追加
- 配線元: `src/server.ts` (`discordBotDeps` / `slackBotDeps` 構築部、 :474-535 付近)
  と `src/discord-worker.ts`

### 手順
1. `DiscordBotDeps` / Slack 側 deps 型にフィールド追加、 bot 内の直 import を削除。
2. bot.ts:196 / bot.ts:135 (RWF runner 構築) と bot.ts:486 (reactions の repin
   コールバック) を deps 経由に置換。
3. server.ts / discord-worker.ts で実体 (`runClaude`, `repinSession`) を注入。
   discord-worker.ts は既に `runClaude` を import している (:33) のでそのまま渡す。

### 受け入れ条件
- [ ] `discord/**`・`slack/**` から `rules/claude-runner.ts` と `control/**` への
      import が 0 (V7/V8 削除。 depcruise ルール `chat-no-core-runner` が
      許容なしで green)
- [ ] RWF (絵文字リアクション → headless 実行) が embedded / worker 両モードで
      動作 (手動確認手順を PR に記載)
- [ ] `npm test` green

### やらないこと
- bot 内の repo 直読み (V9) の解消 — T2-4 のスコープ。 ここでやると PR が肥大する。

---

## T1-6: V10 — cost router の Discord repo 依存除去 {#t1-6}

### 目的
`app.ts:271-272` で `costRouter` に `channels: deps.discordChannels`
(Discord repo) を渡している C→B 依存を、 関数契約に置換する。

### 対象
- `src/api/cost.ts` — `channels` dep の使用箇所 (channel 名解決)
- `src/app.ts` — 配線

### 手順
1. `api/cost.ts` 内で `channels` (DiscordSessionChannelsRepo) から
   実際に呼んでいるメソッドを特定する (channel 名 or channel-session マップの
   読み取りのはず)。
2. dep を `resolveSessionChannel: (sessionId: string) => { name: string; ... } | null`
   のような **最小の読み取り関数型** に置換 (戻り値は現使用フィールドのみ)。
3. `app.ts` で `deps.discordChannels` をラップした関数を渡す
   (コンポジションルートは軸をまたいでよい — depcruise 除外対象)。

### 受け入れ条件
- [ ] `api/cost.ts` から `db/discord-repo` の型 import が消える (V10 削除)
- [ ] `/v1/cost/*` 系エンドポイントのレスポンスが変更前後で一致
      (代表 1 リクエストの before/after を PR に貼る)
- [ ] `npm test` green

---

## T1-7: V14 — sweeper → dispatcher 直呼びの eventBus 化 {#t1-7}

### 目的
`sweeper.ts:67-79` がコアの掃除処理の中で `dispatcher.onSessionLost` を直接
呼んでいる A→B 到達を解消し、 「コアは event を emit するだけ、 chat 側の
反応は server.ts の既存 adapter (eventBus→dispatcher, :663-701) に集約」へ揃える。

### 対象
- `src/sweeper.ts` — dispatcher 依存の除去
- `src/server.ts` — eventBus 購読 adapter に `session.lost` →
  `dispatcher.onSessionLost` の転送を追加 (既に同型の転送が並んでいる)

### 手順
1. `sweeper.ts` は既に `eventBus.emit("session.lost", ...)` している (:69,79 付近) —
   dispatcher 直呼びと二重になっていないか先に確認し、 emit 一本に統一。
2. server.ts の購読ブロックに `session.lost` ハンドラを追加して
   `dispatcher.onSessionLost(...)` を移設。 **discord-worker 側の購読と
   二重発火しない**ことを確認 (worker は WS 経由で別プロセスの eventBus に
   再 emit される — server.ts 側の転送は embedded/worker 判定の既存分岐に従う)。
3. sweeper のコンストラクタ/引数から dispatcher を外し、 呼び出し元
   (`server.ts` の `startSweeper`) を追随。

### 受け入れ条件
- [ ] `sweeper.ts` に dispatcher への参照が 0 (V14 削除)
- [ ] lost 検知時のチャット通知が従来どおり 1 回だけ発火する
      (fake timer + fake dispatcher の統合テストを 1 本追加して担保)
- [ ] `npm test` green
