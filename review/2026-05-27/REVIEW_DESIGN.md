# 設計レビュー (Concordia)

| リポジトリ | Concordia |
| --- | --- |
| 対象 HEAD | 23271d0 (2026-05-27) |
| 対象コミット範囲 | 142538d 〜 23271d0 (4 commits) |

## 1. 設計強度 (A)

| 観点 | 所見 |
|------|------|
| 障害分離 | Discord bot (discord.js Client + WebhookPool) を本体プロセスに同居。bot 無効時 (env 未設定) は no-op で既存 web UI に影響なし。single sqlite SPOF + webhook token 永続化による復旧経路確保 |
| 冪等性 | `ensureDiscordLayout` (guild/category/meta-channel の idempotent 作成)、webhook pool cache (channel_id key)、session-channel DB UNIQUE (session_id) で重複制御、chat_message_reactions UNIQUE(message_id, discord_user_id, kind) で reaction dedup |
| 入力バリデーション | Zod schema 全 API endpoint 継続適用、sessionChannelSlug regex 事前 compile、readDiscordEnv で env type 安全化 (partial) |
| エラーハンドリング | MessageCreate/Reaction event の bot/webhook 投稿 exclude、channel 削除 graceful (getForSession null return)、webhook fetch failure は warn log + null 返却で ingress 側で fallback 可能 |
| リトライ・タイムアウト | Discord API 操作に公式 retry 機構 (discord.js 内蔵)。channel rename cooldown 5 min を DB に持ち、cooldown 内は status 更新のみで skip (短期 idle↔active 振動吸収) |
| 状態管理 | discord_session_channels.status enum (active / lost / ended)、last_rename_ts で rate limit guard、prompt event ごとに dedup (hasUndelivered による title-suggest 1 件キープ) |

本 4 commit で設計強度は維持。session → Discord channel への射影が新規、既存 stat/task/rule engine との結合点は event bus (eventBus.subscribe) 経由で疎結合。

## 2. 設計思想の一貫性 (A)

- **レイヤー**: API → Repo → DB → Schema の単方向継続。Discord layer は独立し、event bus で main loop と通信
- **命名**: `src/discord/` 配下は kebab-case ファイル、DB schema snake_case、TS code camelCase で統一
- **EventBus pattern**: session.started / session.ended / chat.posted など event-driven で、subscriber が独立に動作 (rules engine / discord egress / stat scheduler が並列)
- **Provider abstraction**: claude-code / gemini-cli / codex-cli の provider interface は既存、Discord は integrator role として bot.ts が各層を orchestrate
- **Configuration**: env var + DB の 2 層。env で feature gate (CONCORDIA_DISCORD_ENABLED)、DB で guild_id / category_id 等の state 永続化で、config drift を防止
- **Error handling philosophy**: graceful degrade (bot 起動失敗 → web UI は動く、egress 失敗 → meta channel は chat 受け取り可能)

前回 142538d ("CONCORDIA_SESSION_ID を session_id 解決の最優先") の hook 優先化方針と一貫性保持。

## 3. モジュール分割度 (A)

| モジュール | 責務 | 所見 |
| --- | --- | --- |
| `src/discord/bot.ts` | lifecycle / event dispatch | Client ready → ensureDiscordLayout → eventBus.subscribe で全 event 統一 dispatch |
| `src/discord/config.ts` | guild/category/meta-channel idempotent | `ensureDiscordLayout` / `ensureCategory` / `ensureMetaChannel` の functional decomposition |
| `src/discord/session-channel.ts` | session state → Discord channel | session.started/lost/ended の状態遷移、channel rename rate limit guard |
| `src/discord/webhook-pool.ts` | webhook client cache | getForSession で DB → cache → new の lookup pipeline |
| `src/discord/egress.ts` | Concordia → Discord | chat.posted / transcript.frame event を session/meta channel に webhook 経由投稿 |
| `src/discord/ingress.ts` | Discord → Concordia | MessageCreate を meta channel で loopback /v1/chat に、session channel で slash-command 誘導 |
| `src/discord/reactions.ts` | message emoji → task record | MessageReactionAdd/Remove を chat_message_reactions に upsert |
| `src/discord/formatter.ts` | naming / emoji / serialization | sessionChannelSlug regex、classifyEmoji fine/bad/raw、formatter.test.ts でカバー |
| `src/db/discord-repo.ts` | CRUD | discord_config / discord_session_channels / discord_message_map / chat_message_reactions の repo メソッド群 |
| `web/src/pages/SessionDetail.tsx` | session detail UI | 8 section (header/repos/conversation/input/stat/buttons/event-log/transcript)、component 細分化検討の余地あり |

循環依存なし。session / task / chat / personas repo を dependency injection で提供。

## 重大指摘

なし。Discord integration は既存設計の拡張として自然。
