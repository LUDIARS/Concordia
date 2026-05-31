# Discord bot を動かすための設定 (discord)

## 目的

Concordia の状態 (active session / cost / monitor) を Discord に出し、 slash command で session を操作する。 bot は Concordia backend と **同一プロセス内**で動く (`startBackend()` → `startDiscordBot()`)。 設計詳細は [`spec/discord-ui.md`](../discord-ui.md) / [`spec/discord-control-ui.md`](../discord-control-ui.md)。

bot は **opt-in**。 `CONCORDIA_DISCORD_ENABLED=1` でない限り完全 no-op で、 本体 (Web UI / hook 連携) には一切影響しない (`src/discord/bot.ts:63`)。

## 設定キー

正本は [`config-reference.md` §3](config-reference.md#3-discord-bot)。

| キー | 必須 | 意味 |
|------|------|------|
| `CONCORDIA_DISCORD_ENABLED` | ◯ (`1`) | これが `1` のときだけ bot 起動。 |
| `CONCORDIA_DISCORD_TOKEN` | ◯ | Bot token。 欠けると起動 skip (warn)。 |
| `CONCORDIA_DISCORD_GUILD_ID` | ◯ | 招待先 guild (server) ID。 欠けると起動 skip。 |
| `CONCORDIA_DISCORD_APPLICATION_ID` | △ | slash command 登録用。 欠けると bot は動くが slash command 未登録。 |
| `CONCORDIA_DISCORD_COST_REFRESH_MIN` | × | cost channel 更新間隔 (分、 最小 10)。 |
| `CONCORDIA_DISCORD_TRANSCRIPT_LOG_MAX` | × | transcript ログ転送の最大件数 (既定 1200)。 |

`token` / `guildId` は `readDiscordEnv()` で trim される (`src/discord/types.ts`)。

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
| `/spawn provider [cwd]` | 新 session を spawn (`provider` = claude/codex/gemini)。 bot が in-process で `.spawn.token` を読み `/v1/spawn` を Bearer 認証で叩く ([spawn.md](spawn.md))。 |
| `/enter` | 対象 session に改行 (Enter キー) だけを inject (`/v1/sessions/:id/inject`)。 |
| `/skill name` | session に skill を渡す。 |
| `/stat` | 現在の Concordia stat を表示。 |
| `/end-session` | 対象 session を終了。 |

session 対応 channel ↔ session の双方向は [`spec/discord-lictor-relay.md`](../discord-lictor-relay.md) / [`spec/discord-session-direct-inject.md`](../discord-session-direct-inject.md) を参照。

## 認証モデルに関する注意

Concordia 本体は loopback bind + 認証なしが信頼境界 (`spec/service-schema.md`)。 Discord 側からの操作 (`/spawn` 等) も bot が loopback で Concordia を叩くだけで、 bot 自身の admin 判定キーは env には無い。 `/spawn` だけは `.spawn.token` の Bearer 認証を経由する (bot は同プロセスなのでファイルを直読みできる)。

> 注: Discutere (Di) は「認証を Discord 署名検証 + admin-id allowlist に寄せる」 設計だが、 それは別サービス。 **Concordia 側に Discord admin-id allowlist の env キーは現状存在しない** (実装確認済)。 ここに allowlist 系キーを書かない。

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

- [`spec/discord-ui.md`](../discord-ui.md) / [`spec/discord-control-ui.md`](../discord-control-ui.md) — UI 設計
- [spawn.md](spawn.md) — `/spawn` が使う token / cwd
- [config-reference.md](config-reference.md) — 全キー正本
