---
type: feature
title: "Discord ↔ Lictor 仲介リレー設計 (返信混線の根治)"
description: "AI エージェントが Concordia /v1/chat を直叩きして session_id を自己申告することで発生していた返信混線を根治する設計。Lictor sidecar が channel ID と session ID を authoritative に保持し、AI は中身だけ Lictor 経由で渡す仲介リレーアーキテクチャ。"
service: concordia
domain: chat-platforms
tags:
  - discord
  - relay
  - session-coordination
  - websocket
  - typescript
  - injection
  - state-machine
  - webhook
status: implemented
related:
  - ../feature/discord-ui.md
  - ../interface/service-schema.md
updated: 2026-06-30
---


# Discord ↔ Lictor 仲介リレー設計 (返信混線の根治)

2026-05-30 起草。 関連: [discord-ui.md](./discord-ui.md) / [service-schema.md](../interface/service-schema.md) /
Lictor `DESIGN.md`。

## 1. 問題: 返信の混線 (crosstalk)

これまで **AI エージェント自身が Concordia の `/v1/chat` を直叩き**し、`session_id` /
`author_label` / `channel` / `in_reply_to` を自分で詰めていた (`.claude/skills/concordia`)。
特に致命的なのが、対話有効化経路で AI が **自分の `session_id` を「cwd 配下で最新更新の
JSONL ファイル名」から推測**していた点。

```
共有 working tree で複数セッションが並走
  → 「最新 JSONL」推測が別セッションの id を掴む
  → AI が他セッションになりすまして POST
  → egress が findBySessionId(その誤った id) でそのセッションの channel に流す
  → 返信が別セッションの channel に出現 (= 混線)
```

1:1 の `discord_session_channels` マッピング自体は堅牢だった。混線は **identity を
AI に自己申告させていた**ことに起因する。

## 2. 方針 (2026-05-30 ユーザ決定)

- **対象の Discord channel ID を Lictor 側が保持する。** Concordia が bot と channel 作成を
  保持し、登録時に channel ID を Lictor へ返す。Lictor はそれを握り、以後のリレーに明示する。
- **AI エージェントは Concordia と直接通信しない。** sidecar である Lictor が全 やり取りを
  仲介・管理する。AI は `session_id` も channel も一切名指ししない。
- **transcript も chat も rename も Lictor 経由**で、Lictor が握る authoritative な
  `session_id` / channel ID で送る。

不変条件 (invariant):

> **AI は自分や他者の `session_id` / `channel_id` を名乗らない。**
> identity と routing は、登録時に自分の id を生成し JSONL を排他 claim している
> Lictor だけが知る。AI は local Lictor sidecar に「中身」だけ渡す。

## 3. アーキテクチャ

```
        ┌──────────────┐    local loopback     ┌─────────────┐   HTTP    ┌──────────┐
 AI ───▶│ Lictor /chat │──(session_id 刻印)───▶│  Concordia  │──webhook─▶│ Discord  │
 (CLI)  │  sidecar     │  (+ discord_channel_id)│  /v1/chat   │           │ channel  │
        │              │                        │  egress     │           └──────────┘
        │ holds:       │◀──GET discord-channels─│             │
        │  session ch  │                        └─────────────┘
        │  meta chs    │
        └──────────────┘
```

- Concordia は今まで通り `discord.js` bot を持ち、`session.started` で session channel を
  作成 (`onSessionRegistered`)。
- Lictor は登録直後に `GET /v1/sessions/:id/discord-channels` をポーリングし、
  自分の session channel ID + meta channel ID 群を取得して `meta.discord` に保持する。
- Lictor の relay (`/v1/chat` / transcript-frame) は `session_id` を URL/body で明示し、
  さらに保持している `discord_channel_id` をタグ付けする。
- Concordia egress は **明示 `discord_channel_id` があればそれを最優先**で webhook 送信先に
  する (session→channel の DB ルックアップを routing の権威から外す)。

## 4. API 変更

### 4.1 Concordia (新規 / 拡張)

| Verb | Path | 変更 | 用途 |
|------|------|------|------|
| GET  | `/v1/sessions/:id/discord-channels` | **新規** | Lictor が自分の channel ID 群を取得 |
| POST | `/v1/chat` | `discord_channel_id?` を受理 → metadata に格納 | 明示 routing |

`GET /v1/sessions/:id/discord-channels` レスポンス:

```jsonc
{
  "ok": true,
  "session_channel_id": "123...",      // discord_session_channels.channel_id (未作成なら null)
  "meta_channels": {                    // discord_config.*_channel_id
    "chitchat": "...", "consultation": "...", "houkoku": "...", "system": "..."
  }
}
```

`session_channel_id` は channel 作成が非同期 (`session.started` event 経由) のため、
登録直後は null になりうる。Lictor は数回リトライして埋める。

### 4.2 Lictor sidecar (loopback `127.0.0.1:$LICTOR_PORT`)

| Verb | Path | 変更 | 説明 |
|------|------|------|------|
| POST | `/v1/chat` | `channel` を保持 channel ID に解決し `discord_channel_id` を付与 | identity は sidecar が刻印 |
| GET  | `/v1/concordia/session` | `discord` (保持 channel 群) を同梱 | AI/skill が確認用 |

Lictor `/v1/chat` body (AI/skill が叩く):

```jsonc
{ "channel": "chitchat|consultation|報告|session", "text": "...", "in_reply_to": 42 }
```

- `session` を指定すると自分の session channel に出す。
- `session_id` は **受け取らない** (sidecar が `ctx.sessionId` で刻印)。
- `author_label` 省略時は persona から `<role> / <name>` を自動生成。

### 4.3 egress 優先順位 (`handleChatPosted`)

```
1. metadata.source === "discord"     → skip (自己ループ防止、従来通り)
2. metadata.discord_channel_id 有り  → そのまま送信先に採用 (★新規・最優先)
3. forceMeta (chitchat/consultation/報告) → meta channel
4. session row 有り                  → session channel
5. fallback                          → meta channel
```

## 5. rename も Lictor が管理

channel rename は元々 Lictor 起点で動いている (今回もこの構造を踏襲):

- **タイトル rename**: Lictor の auto-title → `/v1/sessions/:id/title-suggestion` →
  Concordia が `title_renamed` event を emit → `onSessionTitleChanged` が **Lictor の握る
  channel** (= `findBySessionId` で引く同一 row) を rename。
- **状態 emoji rename** (🟢/🟥/⚪): Lictor の WS 切断 → `session.lost` /
  終了 → `session.ended` を起点に `onSessionStatusChanged`。

Lictor が `session_channel_id` を保持することで、rename 対象は常に Lictor の握る channel に
一致する (divergence なし)。rename の rate-limit (5min cooldown) は Concordia 側で従来通り守る。

## 6. concordia skill の書き換え

`.claude/skills/concordia` を全面改訂:

- **削除**: `session_id` を JSON ファイル名から推測する節 (混線の元凶)。
- **削除**: Concordia `/v1/chat` / `/v1/reports` の直叩き curl。
- **追加**: 全投稿を `http://127.0.0.1:$LICTOR_PORT/v1/chat` 経由にする。
  `LICTOR_PORT` が無い (= Lictor 非ラップ) 環境では「Concordia 連携は無効」とみなして no-op。
- task kind (`chitchat-suggest` / `review-summary` / `chat-reply` / `daily-report`) は
  そのまま。投稿先だけ Lictor sidecar に変更。

## 7. 後方互換 / 移行

- Concordia `/v1/chat` の `session_id` 直指定は **Discord ingress (人間の meta channel 発言)
  と Lictor 経由のみ**が使う。AI が直接使わなくなれば混線経路は消える。
- `discord_channel_id` は optional。既存 client (旧 Lictor) は送らず、egress は従来 fallback で動く。
- transcript-frame は元々 `session_id` を URL で明示しており authoritative。今回変更なし
  (「Lictor が transcript をリレー」 は既存挙動の追認)。

## 8. テスト

- Concordia: `discord-channels` endpoint (session 有/無, channel 未作成時 null)。
  egress の `discord_channel_id` 優先 routing 単体。
- Lictor: `/v1/chat` の channel 解決 + `discord_channel_id` タグ付け (smoke-sidecar)。
  `discordChannels()` クライアントメソッド。
