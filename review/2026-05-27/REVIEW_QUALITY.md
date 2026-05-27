# 品質保証レビュー (Concordia)

| リポジトリ | Concordia |
| --- | --- |
| 対象 HEAD | 23271d0 |

## 1. コード品質 (B)

| 観点 | 評価 | 所見 |
|------|------|------|
| 可読性 | A | JSDoc 整備、variable naming clear (lastRepoPath, enqueueTitleSuggest)、component props 明確 |
| 複雑度 | B | SessionDetail.tsx 単一ファイル肥大化。Component 分離 (HeaderPanel, ReposPanel, ConversationPanel, InputPanel, StatPanel, ActionButtonRow) で maintainability 向上見込 |
| 一貫性 | A | eslint config 適用、prettier format 一貫 |
| 注釈品質 | B | JSDoc + inline comment は適切、しかし Discord webhook-pool に VERBOSE logger が過剰 (下記) |

### Medium: コードボリュームの最適化

`web/src/pages/SessionDetail.tsx` は機能多数を一つに含むが、ファイル分割で利点:
- HeaderPanel.tsx (session info header)
- ActiveReposPanel.tsx (repos chip display)
- ConversationPanel.tsx (recent messages)
- InputPanel.tsx (textarea + send)
- LatestStatPanel.tsx (stat display)
- ActionButtonRow.tsx (stop / stat / rename buttons)

現状でも動作しているので Critical ではない → next iteration の refactor 対象。

## 2. テスト戦略・カバレッジ (B、重大指摘 1)

| 観点 | 評価 | 所見 |
|------|------|------|
| Unit test | B | vitest、repo-change-watcher.test.ts 等の新規ケース追加。formatter.test.ts は sessionChannelSlug / classifyEmoji を網羅 |
| Integration test | C | Discord API 部 (bot lifecycle, message send/receive) は実 test guild の手動検証のみ (unit mock 困難) |
| E2E test | C | Playwright/Cypress 未導入。Web UI + Discord bot の合成テストなし |
| Coverage % | C | `npm test --coverage` 未実行。現状 coverage 計測不可 |
| Regression test | B | title-watcher prompt debounce 撤去時に test case を 30s debounce → hasUndelivered dedup へ書き換え。変更前後の同等性は保証 |

### 重大指摘 1: Discord unit test 制限

`src/discord/` モジュールは discord.js Client / Guild / WebhookClient を使うため unit test での mock が難しい。現状は `formatter.ts` (regex / emoji enum) の unit test のみ。

**改善方向:**
1. **Discord API 部分の隔離**: `src/discord/bot.ts` 上位で DI により Client を注入 → interface 抽象化 → test で mock 注入
2. **Event handler を純関数化**: `handleEvent(ev, repos, discordConfig)` 形式で side-effect なしのロジックのみ unit test
3. **実 test guild の自動化**: GitHub Actions で Discord bot を test guild に登録 → message create / reaction を実 trigger

coverage % 計測未実行なので、`npm test --coverage` 実行後 target (line coverage 70%) を設定。

## 3. ライセンス遵守 (A)

| 観点 | 評価 | 所見 |
|------|------|------|
| LICENSE | A | MIT ファイル存在 |
| Dependencies | A | hono / zod / better-sqlite3 / discord.js (Apache 2.0) いずれも permissive license |
| NOTICE | B | package.json に dependencies あり、npm publish 時に THIRD_PARTY_LICENSES.txt 自動生成設定が必要 |

package-lock.json は最新 (PR #50 で discord.js transitive deps 追加)。

## 4. ドキュメント完備性 (B、重大指摘 1)

| 観点 | 評価 | 所見 |
|------|------|------|
| README | B | 概略 / setup / architecture は十分。Discord 有効化方法 (env vars) が PR #50 で .env.example に comment 記載 |
| spec/*.md | B | service-schema.md / multi-provider.md / discord-ui.md / discord-ui-pr-b.md (343 L) で詳細。ただし CLAUDE.md 不在 → 新規開発者参入 barrier |
| docs/*.md | B | hooks-claude-code.md / codex-cli.md あり、CONTRIBUTING.md 不在 → PR workflow / test convention 不明確 |
| CLAUDE.md | **C (重大指摘)** | 未整備。session_id hook priority (142538d) / discord enable (PR #50) / title-watcher expand (PR #47) / SessionDetail refactor (PR #49) を CLAUDE.md に文書化必須。新規開発者・maintainer 向け |
| 変更ログ | C | CHANGELOG.md なし。v0.1 / v0.2 / v0.3 roadmap は README にあるが、release note 未追跡 |

### 重大指摘 1: CLAUDE.md 新規作成

**内容:**
- **Concordia v0.1 architecture overview** — 既存 README からの抜粋整理
- **Session lifecycle** — hook flow (SessionStart → post /v1/sessions → event append → Stop → report)
- **Provider abstraction** — claude-code / gemini-cli / codex-cli の差分
- **Discord integration** (PR #50) — env enable / bot lifecycle / webhook pool / rate limit cooldown
- **Title watcher** (PR #47/#48) — initial stat / repo_change / prompt event の 3 trigger、hasUndelivered dedup
- **SessionDetail refactor** (PR #49) — 縦 stack layout、textarea Enter/Ctrl+Enter、手動 stat/title request endpoint
- **Testing conventions** — unit (vitest) / integration (実 guild) / fixture setup
- **Debugging tips** — VERBOSE logger / pino log level / Discord rate limit 問題対処

**対象ファイル:** `CLAUDE.md` 新規作成、1000+ 字目標

## 5. パフォーマンス・ベンチマーク (C、重大指摘 1)

| 観点 | 評価 | 所見 |
|------|------|------|
| Profiling | C | pino log で duration_ms を一部計測 (stat scheduler, rule apply)。Web UI load time / Discord event dispatch latency は未計測 |
| Bottleneck | B | sqlite WAL / webhook pool cache の設計は適切。ただし "10 concurrent session × 2 events/sec" シナリオの負荷テスト未実行 |
| SLI definition | **C (重大指摘)** | spec/sre.md 不在。SLI (session create p95 < 3sec、chat egress p99 < 1sec、web detail page load p95 < 800ms) の定義必要 |
| Benchmark CI | C | `vitest bench` 構文なし。rule engine / stat scheduler / webhook dispatch の throughput bench 未追加 |
| Caching strategy | A | webhook pool in-memory cache (session_id → WebhookClient) が有効。session detail page も useLiveQuery + WS で real-time update 最適化 |

### 重大指摘 1: SLI/SLO 定義 + benchmark CI

**spec/sre.md 新規:**
```
## SLI (Service Level Indicators)

- Session create (POST /v1/sessions): p95 < 3 sec, p99 < 5 sec
- Chat message egress (webhook send): p99 < 1 sec, fail rate < 0.1%
- Session detail page load: p95 < 800 ms (browser load + WS connect)
- Rule engine apply (per session): p99 < 500 ms
- Discord channel create: p95 < 5 sec (rate limit 考慮)

## SLO (Service Level Objectives)

- Availability: 99.5% (deploy 除外)
- Error rate: < 0.5% (5xx, timeout)
```

**Benchmark CI (Makefile / GitHub Actions):**
```bash
npm run benchmark  # vitest bench --run
```

## 6. クロスプラットフォーム互換 (B)

| 観点 | 評価 | 所見 |
|------|------|------|
| Node version | A | package.json "engines": { "node": "22" } 固定。v18/v20 サポートテスト未実行 |
| Web browser | B | React 19 + Foundation UI 標準、Safari/Chrome/Firefox 互換予想。実 CI 行列 (browser matrix) なし |
| OS | B | sqlite WAL は Windows/macOS/Linux 全対応。大小文字感度 (Windows path) 未保証 |
| Character encoding | A | utf-8 統一、transcript JSONL も utf-8 |
| Timezone | A | unix sec (utc 基準) 統一、local tz conversion は frontend (new Date()) 委譲 |
