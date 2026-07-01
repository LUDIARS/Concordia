---
type: feature
title: "Concordia Discord-UI 統合 — 仕様 (PR-A)"
description: "Concordia の session lifecycle イベントを hook して Discord channel を自動作成し、チャット/トランスクリプトの双方向 egress・ingress および reaction 評価記録を実現する統合仕様 (PR-A スコープ)。bot 常駐・session channel CRUD・webhook 経由の persona 投稿・SQLite 4 テーブル追加を定義する。"
service: concordia
domain: chat-platforms
tags:
  - discord
  - typescript
  - sqlite
  - webhook
  - event-driven
  - state-machine
  - persona
  - relay
status: implemented
related:
  - discord-ui-pr-b.md
updated: 2026-06-30
---


# Concordia Discord-UI 統合 — 仕様 (PR-A)

## 目的

Web UI でチャットを打ちづらい課題を、 Discord を主 UI として使う形で解消する。 起動経路 (Memoria の AI 委託 / Discord slash command / 手動 `lictor claude`) を問わず、 Concordia の `session.started` event を hook して Discord channel を auto-create する。

PR-A スコープは **bot 常駐 + session channel CRUD + chat/transcript egress + reaction 評価記録**。 Slash command と AskUserQuestion bridge は PR-B。

## 起動

`CONCORDIA_DISCORD_ENABLED=1` の場合のみ bot を起動する。 未設定なら完全 no-op (= 既存 Web UI 運用に影響なし)。

| env | 必須 | 説明 |
|---|---|---|
| `CONCORDIA_DISCORD_ENABLED` | 任意 | `1` で bot 起動 |
| `CONCORDIA_DISCORD_TOKEN` | enabled 時必須 | Discord bot token (Discord Developer Portal で発行) |
| `CONCORDIA_DISCORD_GUILD_ID` | enabled 時必須 | ターゲット guild (server) の ID |

Discord Developer Portal で Bot Application を作る際、 **MessageContent intent を有効化** する (privileged)。

## Discord 構造 (idempotent 作成)

```
Guild
├─ Category 🗂 メタ
│   ├─ #chitchat          ← 雑談 (chat.posted channel=chitchat の双方向)
│   ├─ #consultation      ← 相談 (chat.posted channel=consultation)
│   ├─ #houkoku           ← 報告 / daily-report
│   └─ #system            ← session lifecycle / persona / kill switch
├─ Category 🟢 セッション (active)
│   └─ #🟢-s-<id4>-<role>  ← session.started で auto-create
└─ Category 🗄 アーカイブ
    └─ #⚪-s-...           ← session.ended で移動 + emoji 更新
```

Channel 名規則は `formatter.ts:sessionChannelSlug` で固定 (先頭 4 文字 + role slug)。

## State 機械 (channel name の emoji)

| Event | 遷移 | Discord 動作 |
|---|---|---|
| `session.started` | (new) → 🟢 active | channel 新規作成 (active category) |
| `session.lost` (sweeper) | active → 🟥 lost | rename (cooldown 内なら deferred) |
| `session.ended` (DELETE) | active/lost → ⚪ ended | rename + archive category へ setParent |

**rename rate limit guard**: Discord は channel rename を 2 回/10 分 (実測 5-10 min) に制限する。 `discord_session_channels.last_rename_ts` で 5 分 cooldown を持ち、 cooldown 内の rename は **skip** する。 状態が変わってもまだ rename できない場合、 DB 上の status は先に更新され、 次回 event 又は手動操作で flush される (短期 idle ↔ active 振動を吸収するためにも有用)。

## Egress (Concordia → Discord)

`bot.ts` の `eventBus.subscribe(...)` で event を捕捉:

| event | 行先 | username/avatar |
|---|---|---|
| `chat.posted` (session_id 指定 + session channel あり) | 該当 session channel | persona display_name (chat_messages.author_label) |
| `chat.posted` (session_id 無し) | meta channel (chitchat/consultation/houkoku/system) | chat_messages.author_label |
| `transcript.frame` (kind=text, role=assistant) | session channel | persona display_name |

投稿は **webhook 経由**。 channel に 1 つだけ webhook を作って `WebhookClient.send({ content, username, avatarURL })` で per-message 上書き → persona ごとに別 user に見える表示。

`chat-mute` ON 時は **egress 全停止** (ingress は通る)。

## Ingress (Discord → Concordia)

`MessageCreate` event:
- bot / webhook の投稿は無視 (`author.bot`)
- DM は対象外
- meta channel (chitchat / consultation / houkoku / system) → `POST /v1/chat` (loopback) で chat に投稿、 author は `member.nickname ?? user.username`
- session channel での投稿 → PR-A では「slash command 使ってください」 案内 reply のみ (PR-B で /inject 実装)

## Reaction (fine / bad / raw 評価)

`MessageReactionAdd` / `MessageReactionRemove`:
1. Discord message_id → `discord_message_map` → `chat_messages.id` 逆引き
2. emoji を `classifyEmoji` で `fine` / `bad` / `raw:<emoji>` に分類
3. `chat_message_reactions` に row を upsert (`UNIQUE(message_id, discord_user_id, kind)` で重複 NO-OP)
4. Bot 自身の reaction は無視

emoji マッピング:
- 👍 / ✅ / ❤️ → `fine`
- 👎 / ❌ → `bad`
- その他 → `raw:<emoji>` (記録のみ)

将来 RLHF 学習 / persona feedback などに使えるよう、 `chat_messages` の原文と join できる形で保持する。

## チャットの削除はしない

Bot は `Message.delete()` を **一切呼ばない**。 ユーザがピン留めしたい場合に備えて過去メッセージは全部残す。 削除が必要なときは Discord 側の手動操作で。

## DB schema (新規 4 table)

```sql
CREATE TABLE discord_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE discord_session_channels (
  session_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  webhook_id TEXT,
  webhook_token TEXT,
  status TEXT NOT NULL DEFAULT 'active',     -- 'active' / 'lost' / 'ended'
  last_rename_ts INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL
);
CREATE TABLE discord_message_map (
  discord_message_id TEXT PRIMARY KEY,
  chat_message_id INTEGER NOT NULL,
  ts INTEGER NOT NULL
);
CREATE TABLE chat_message_reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,                -- chat_messages.id
  discord_user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                          -- 'fine' / 'bad' / 'raw:<emoji>'
  ts INTEGER NOT NULL,
  UNIQUE (message_id, discord_user_id, kind)
);
```

## 失敗時の振舞い

- bot login 失敗 → log + 既存 Concordia は止めない (discord.js が自動 reconnect)
- channel 作成失敗 → DB に row を残さず次回 event で retry
- webhook 作成失敗 → channel.send fallback (= bot user 名で投稿、 persona 表示が出ない)
- rename cooldown 内 → skip (status は先に DB 更新)

## モジュール構成

| ファイル | 役割 |
|---|---|
| `src/discord/bot.ts` | discord.js Client lifecycle + ready hook + event subscribe |
| `src/discord/config.ts` | guild / 3 category / 4 meta channel idempotent 作成 |
| `src/discord/session-channel.ts` | session.started/lost/ended の channel CRUD |
| `src/discord/webhook-pool.ts` | channel→webhook 1:1 キャッシュ |
| `src/discord/egress.ts` | eventBus → channel.send (webhook 経由) |
| `src/discord/ingress.ts` | MessageCreate → POST /v1/chat or 案内 reply |
| `src/discord/reactions.ts` | ReactionAdd/Remove → chat_message_reactions |
| `src/discord/formatter.ts` | text 整形 (slug / emoji / chunk / author name) — 純関数 |
| `src/discord/types.ts` | env 読み + channel kind 変換 |
| `src/db/discord-repo.ts` | 4 table の repo + classifyEmoji |

## PR-B (後続) の予定

詳細実装指示は [discord-ui-pr-b.md](discord-ui-pr-b.md) (codex 向け)。 主要項目:

- **Slash commands** 9 個: `/spawn` `/inject` `/skill` `/keys` `/answer` `/stat` `/chitchat` `/consultation` `/end-session` + autocomplete
- **Modal** で `/inject` 等の長文入力 (4000 文字)
- **Embed** 整形 (chat / transcript / status / report / question を色 + footer + fields で rich 化)
- **AskUserQuestion bridge** (Concordia 側): `POST /v1/sessions/:id/pending-question` を受けて session channel に Button 付き embed 投稿、 押下 → `POST /answer-question` で answer 流入 (`question.answered` event)
  - options 5 個以下 → Button、 6 個以上 → SelectMenu
- Lictor 側の AskUserQuestion 捕捉は **別 PR (LUDIARS/Lictor)**

## 将来検討

- **Polls (Discord 2024 新機能)**: AI に方針投票させる UX 案。 `pending_question` で `kind: 'poll' | 'buttons' | 'select'` を選べる拡張余地を残す (ALTER ADD COLUMN で後付け可能)。 button bridge より一目で結果が見える
- **Application Emoji** を persona avatar 代わりに使う (今は avatar 未対応、 persona.discord_avatar_url 列追加で対応)
- **Forum Channel + Tag** で archive を表現する別案
- **Scheduled Events** で daily-report のタイミングを Discord カレンダーに出す

## env 設定方法 (現状の運用)

Concordia は Infisical を使わず、 `tsx watch --env-file-if-exists=.env src/server.ts` で **`.env` を直接 load** する (PR-A で `package.json` に `--env-file-if-exists` を追加)。

手順:
1. `cp .env.example .env`
2. `.env` の `CONCORDIA_DISCORD_ENABLED=1` をセット
3. Discord Developer Portal で Bot Application を作成、 token を取得 → `CONCORDIA_DISCORD_TOKEN=...`
4. 招待先 server (guild) の右クリックで ID をコピー → `CONCORDIA_DISCORD_GUILD_ID=...`
5. Developer Portal の Bot 設定で **MessageContent intent** を有効化 (privileged)
6. OAuth2 URL Generator で `bot` + `applications.commands` scope + 必要な channel/webhook 権限を選び、 招待 URL で server に Bot を追加
7. `npm run dev:backend` 起動 → log に `[discord] logged in as ...` が出れば成功

`.env` は `.gitignore` で除外済 (`.env.example` だけ commit される)。 PR-B では `CONCORDIA_DISCORD_APPLICATION_ID` も必要 (slash command 登録用) になるので、 そのとき `.env.example` に追記する。
