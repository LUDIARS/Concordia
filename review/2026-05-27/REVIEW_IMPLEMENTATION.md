# 実装レビュー (Concordia)

| リポジトリ | Concordia |
| --- | --- |
| 対象 HEAD | 23271d0 |

## 1. データスキーマ (A)

| テーブル | 状態 | 所見 |
|---------|------|------|
| discord_config | 新規 (PR #50) | `(key TEXT PRIMARY KEY, value TEXT)` — guild_id / category_ids / meta_channel_ids を KV で永続。idempotent update pattern で DML safe |
| discord_session_channels | 新規 | `(session_id PK, channel_id, webhook_id, webhook_token, status enum, last_rename_ts, ts)` — session ↔ Discord channel 射影。status=active/lost/ended で state machine。last_rename_ts で Discord rate limit guard |
| discord_message_map | 新規 | `(discord_message_id PK, chat_message_id FK, ts)` — ingress emoji reaction の逆引き用 |
| chat_message_reactions | 新規 | `(message_id, discord_user_id, kind enum, ts, UNIQUE)` — fine/bad/raw emoji を kind で分類。future RLHF 可能性 keep |
| sessions, session_events, session_reports (既存) | — | schema 変更なし。Discord integration は db layer で完全隔離 |

index:
- `discord_session_channels.session_id` (PK lookup fast)
- `discord_message_map.discord_message_id` (PK lookup)
- `chat_message_reactions.message_id, discord_user_id` (dedup UNIQUE) で efficient upsert

CREATE IF NOT EXISTS で idempotent、migration tool なし (manual setup 段階で 1 回のみ実行)。

## 2. 実装品質

| 観点 | 評価 | 所見 |
|------|------|------|
| Code style | A | prettier 既存適用、issue なし |
| Type safety | A | TypeScript strict mode、Zod parse 全 input、discord.js type 豊富 |
| Error handling | B | WebhookPool.getForSession null return は elegant、egress event handler を try-catch で囲む (warn log)。ただし Discord API 例外のうち retryable (429 TooManyRequests) vs fatal (403 Forbidden) の区別が未実装 |
| Logging | B | pino child logger (discord, webhook-pool) で分類済、ただし `${VERBOSE}` prefix log が過剰 (下記) |
| Edge cases | B | channel 削除後 webhook 接続 → null graceful。ただし webhook token 失効 (Discord 上 rotate) 時の fetch failure → 自動再生成なし (manual recovery 必要) |

### Verbose logging 問題

`src/discord/webhook-pool.ts` 等で `const VERBOSE = "[verbose-cs-bug]"` を全主要 log に prefix。これは開発中の verbose bootstrap 用 marker で、commit 前に削除推奨。CI/prod でこの marking が logs に出ると confusion を招く。

→ **AUTOFIX 対象**: VERBOSE prefix の削除または env (DEBUG level) ベースの conditional 切替

## 3. SRE (B、重大指摘 1)

| 観点 | 評価 | 所見 |
|------|------|------|
| Deployment strategy | B | npm run dev / npm run build (Vite) 標準、production build 時の env vars 注入方式が文書化されていない |
| Monitoring / alerting | B | pino log file (logs/concordia.log) はあるが prometheus metrics なし。session count / event throughput / error rate のトラッキング無 |
| Disaster recovery | B | .env backup / webhook token backup 手順の文書化が必要。spec/sre.md 不在 (全体) |
| Capacity planning | C | "session 当 10–20 channel create" 推定のみで、Discord Guild limit (500 ch) 衝突シナリオの runbook なし |

### 重大指摘 1: SRE Runbook 不在

**spec/sre.md 新規作成** — 以下項目を含む:
1. **Pre-flight check**: CONCORDIA_DISCORD_ENABLED=1 のとき env vars 検証 (token 有効性、guild 接続) → startup fail fast
2. **Monitoring dashboard**: session active count / channel count (vs Discord limit 500) / event throughput / webhook retry rate
3. **Disaster recovery**: webhook token 露出 → token 再発行手順 / guild 間の session channel マイグレーション
4. **Performance SLI**: channel create latency p95 < 5 sec、chat egress latency p99 < 2 sec、session detail page load p95 < 1 sec

## 重大指摘

1. **VERBOSE logging 除去** — src/discord/webhook-pool.ts、src/discord/egress.ts 等で `${VERBOSE}` prefix を削除、または env ベースの conditional に切替
2. **spec/sre.md 作成** — deployment / monitoring / capacity planning / disaster recovery runbook
