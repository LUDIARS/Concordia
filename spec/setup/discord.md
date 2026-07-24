---
type: setup
title: "Discord bot を動かすための設定 (discord)"
description: "Concordia の Discord bot を同一プロセス内で起動するためのセットアップガイド。env キーによる opt-in 制御、secret-box 暗号化による DB 保存、hot 再接続、slash command 登録の手順を網羅する。"
service: concordia
domain: chat-platforms
tags:
  - discord
  - typescript
  - webhook
  - lifecycle
  - auth
  - spawn
  - relay
  - rest-api
status: implemented
related:
  - ../feature/discord-ui.md
  - ../feature/discord-control-ui.md
  - ../feature/discord-lictor-relay.md
  - ../feature/discord-session-direct-inject.md
  - spawn.md
updated: 2026-06-30
---


# Discord bot を動かすための設定 (discord)

## 目的

Concordia の状態 (active session / cost / monitor) を Discord に出し、 slash command で session を操作する。 bot は Concordia backend と **同一プロセス内**で動く (`startBackend()` → `startDiscordBot()`)。 設計詳細は [`spec/discord-ui.md`](../feature/discord-ui.md) / [`spec/discord-control-ui.md`](../feature/discord-control-ui.md)。

bot は **opt-in**。 `CONCORDIA_DISCORD_ENABLED=1` でない限り完全 no-op で、 本体 (Web UI / hook 連携) には一切影響しない (`src/discord/bot.ts:63`)。

## 設定キー

正本は [`config-reference.md` §3](config-reference.md#3-discord-bot)。

| キー | 必須 | 意味 |
|------|------|------|
| `CONCORDIA_DISCORD_ENABLED` | ◯ (`1`) | これが `1` のときだけ bot 起動。 |
| `CONCORDIA_DISCORD_TOKEN` | ◯ | Bot token。 欠けると起動 skip (warn)。 |
| `CONCORDIA_DISCORD_GUILD_ID` | ◯ | 招待先 guild (server) ID。 欠けると起動 skip。 |
| `CONCORDIA_DISCORD_APPLICATION_ID` | △ | slash command 登録用。 欠けると bot は動くが slash command 未登録。 |
| `CONCORDIA_DISCORD_COST_REFRESH_MIN` | × | cost channel 更新間隔 (分、 既定 10 / 最小 10)。 |
| `CONCORDIA_DISCORD_MONITOR_REFRESH_MIN` | × | monitor (サービス状態) channel 更新間隔 (分、 既定 10 / 最小 10)。 |
| `CONCORDIA_DISCORD_PR_QUEUE_REFRESH_MIN` | × | PR キュー channel 更新間隔 (分、 既定 15 / 最小 10)。 |

> 上の refresh / idle 系はすべて任意で、 各 channel の更新頻度・インジケータ消灯を微調整する。 全キーの正本は [`config-reference.md` §3](config-reference.md#3-discord-bot)。

`token` / `guildId` は `readDiscordEnv()` で trim される (`src/discord/types.ts`)。

> env は **初期 bootstrap / フォールバック** として使えるが、 **推奨はサービス内設定**(下記)。
> DB に設定された値が env より優先される。

## サービス内設定 (Web UI / API) — env を編集せず設定する

Web UI の **設定 (Settings)** ページ、 または `/v1/admin/discord` API から
token / guild / application / enabled を設定できる。**保存した時点で bot を hot 再接続**
するのでサービス再起動は不要 (Slack 連携と対の構成)。

- token は **secret-box で暗号化して DB に保存**(`discord_config` テーブル、 接続設定キーは
  `conn_` prefix で channel/category id と分離)。 平文では持たず、 GET でも値は返さない
  (set 済みかだけ)。暗号鍵は DB の外に置く: env `CONCORDIA_SECRET_KEY`(任意の passphrase)
  → 無ければ起動時に `concordia.secret.key`(cwd、 gitignore 済)を自動生成。
- DB 値が env より優先。 DB 側を空文字でクリアすると env にフォールバックする。

API:

| Method | Path | 用途 |
|--------|------|------|
| GET | `/v1/admin/discord/config` | redact 済み状態(`token_set` 等、 値は返さない) |
| PUT | `/v1/admin/discord/config` | 設定更新 + hot 再接続。body: `{ enabled?, guild_id?, application_id?, token? }`(空文字=クリア) |
| POST | `/v1/admin/discord/start` `/stop` `/restart` | bot ライフサイクル制御 |

```bash
# 例: token と guild を一括設定して即接続
curl -s -X PUT http://127.0.0.1:11111/v1/admin/discord/config \
  -H "content-type: application/json" \
  -d '{"enabled":true,"guild_id":"123456789012345678","application_id":"123456789012345678","token":"..."}'
```

実装: `src/discord/conn-config.ts` / `src/shared/secret-box.ts`、 ルートは `src/app.ts` の
`/v1/admin/discord/config`。

## 必要な Discord 設定 (Developer Portal)

bot が要求する Gateway intents (`src/discord/bot.ts:73`):

- `Guilds`
- `GuildMessages`
- **`MessageContent`** ← **privileged intent**。 Developer Portal で明示有効化が必要。
- `GuildMessageReactions`
- `GuildWebhooks` ← webhook を使うので、 招待時に **Manage Webhooks** 権限を付与する。

> README / `.env.example` も「Privileged intent MessageContent を有効化」 と明記。 これを忘れると login 後に intent エラーで落ちる。

## 手順

1. Discord Developer Portal で Application + Bot を作成し、 token を発行。 **MessageContent** privileged intent を ON。
2. bot を対象 guild に招待 (Manage Webhooks を含む権限)。 guild ID と Application ID を控える。
3. `.env` に設定:

   ```bash
   CONCORDIA_DISCORD_ENABLED=1
   CONCORDIA_DISCORD_TOKEN=<bot token>
   CONCORDIA_DISCORD_GUILD_ID=<guild id>
   CONCORDIA_DISCORD_APPLICATION_ID=<application id>
   ```

   > token は機密。 `.env` は `.gitignore` 済だが、 値をコミット / 共有しないこと。

4. Concordia を起動 ([core.md](core.md))。 ログに `logged in as <tag>` が出れば成功 (`bot.ts:98`)。 起動時に guild の channel layout を ensure し、 slash command を guild に登録する。

## slash command

`src/discord/commands/` に実装。 guild scope で登録される (`registerGuildCommands`):

| command | 動作 |
|---------|------|
| `/spawn provider [cwd]` | 新 session を spawn (`provider` = claude/codex/gemini)。 Gateway が認証した user ID を exact allowlist と照合後、loopback 内部 API を呼ぶ ([spawn.md](spawn.md))。 |
| `/enter` | 対象 session に改行 (Enter キー) だけを inject (`/v1/sessions/:id/inject`)。 |
| `/stat` | 現在の Concordia stat を表示。 |
| `/end-session` | 対象 session を終了。 |

session 対応 channel ↔ session の双方向は [`spec/discord-lictor-relay.md`](../feature/discord-lictor-relay.md) / [`spec/discord-session-direct-inject.md`](../feature/discord-session-direct-inject.md) を参照。

## 認証モデルに関する注意

Concordia 本体は loopback 内部 API。Discord Gateway が認証した発火 user ID を、設定画面 /
`/v1/admin/reaction-workflow` の `discord_user_ids` exact allowlist と照合してから spawn /
delegation を呼ぶ。ID 欠落・不一致・空 allowlist は全拒否し、service token は使用しない。

## トラブルシュート

| 症状 | 対処 |
|------|------|
| bot が起動しない (`CONCORDIA_DISCORD_ENABLED != 1; skip`) | env が `1` か確認。 |
| `TOKEN / GUILD_ID missing; skip` | token / guild ID の設定漏れ。 |
| login 後に intent エラーで落ちる | MessageContent privileged intent が Developer Portal で未有効。 |
| slash command が出ない (`APPLICATION_ID missing` warn) | `CONCORDIA_DISCORD_APPLICATION_ID` 未設定。 |
| `/spawn` が "token not found" | Concordia が `.spawn.token` を未生成 (本体が起動していない / cwd 不一致)。 [spawn.md](spawn.md)。 |
| cost channel が更新されない | `CONCORDIA_DISCORD_COST_REFRESH_MIN` / channel 権限を確認。 |

## 関連

- [`spec/discord-ui.md`](../feature/discord-ui.md) / [`spec/discord-control-ui.md`](../feature/discord-control-ui.md) — UI 設計
- [spawn.md](spawn.md) — `/spawn` が使う token / cwd
- [config-reference.md](config-reference.md) — 全キー正本
