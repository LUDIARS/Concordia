# AUTOFIX (Concordia, 2026-05-27)

レビュー対象: 23271d0 (Discord bot + SessionDetail refactor + title-watcher)

## 概要

- 修正ファイル数: 0 (PR は本日生成、 マージは人間レビュー後)
- 変更行数: PR 経由のため本ファイル時点では未確定
- カテゴリ別件数: lint=1 / typo=0 / unused_import=0 / dead_code=0 / gitignore=0 / toc=0 / critical_high=0 (ただし bounded fix 候補は別途列挙)
- 関連 PR: 後述 (PR 化候補列挙、 オートマージなし)

本日の自動修正は **PR 作成のみ**。 マージは人間レビュー後。 一部の bounded fix (security / 入力バリデーション) は AskUserQuestion bridge / Discord 設計周りに密接しており、 慎重な人間レビューを要するため REVIEW_*.md と本 AUTOFIX.md に列挙のみとした。

## カテゴリ別

### lint warnings (1 件)

- `src/discord/webhook-pool.ts:15 (および src/discord/egress.ts, src/discord/bot.ts)` — `const VERBOSE = "[verbose-cs-bug]"` の debug prefix を全 log から除去。 PR 化候補 A1

### typo (0 件)

### 未使用 import (0 件), dead code (0 件), .gitignore 漏れ (0 件), TOC ずれ (0 件)

### Critical / High 修正 (0 件)

本日の commit 群に Critical / High 指摘なし (前回からの carry-forward も大型 refactor のみ)。 ただし Medium 級の bounded fix 候補を以下に列挙。

## Bounded Fix 候補 (Medium)

| ID | ファイル | 行 | 分類 | 修正概要 | 優先度 |
|----|---------|----|------|---------|--------|
| A1 | src/discord/webhook-pool.ts ほか | 15, 31-54 | lint | VERBOSE prefix 削除 | Low |
| A2 | .env.example | EOF | docs | Discord env vars 確認 (CONCORDIA_DISCORD_ENABLED / _TOKEN / _GUILD_ID) | Low |
| B1 | src/discord/types.ts, bot.ts | readDiscordEnv | security | enabled=1 で token/guildId 欠落時に throw 化 (silent no-op 廃止) | Medium |
| B2 | web/src/pages/SessionDetail.tsx | input handler | security | textarea 制御文字フィルター (U+202E / NUL / 超長) | Medium |
| B3 | src/discord/egress.ts | sendToSessionChannel | sre | webhook 例外 → meta channel fallback | Medium |
| B4 | src/discord/types.ts, session-channel.ts | rename cooldown | config | DISCORD_RENAME_COOLDOWN_SEC env 化 | Low |

推奨修正順: A1, A2 (lint 一括) → B1, B2 (security bounded) → B3, B4 (sre / config)

## フラグしたが手作業に回した指摘 (= 自動修正の範囲外)

- **spec/sre.md 新設** — SLI / SLO / deployment runbook / monitoring dashboard 仕様 (REVIEW_IMPLEMENTATION.md §3、 REVIEW_QUALITY.md §5)
- **CLAUDE.md 作成** — architecture / provider abstraction / Discord integration / title-watcher / testing convention (REVIEW_QUALITY.md §4)
- **SessionDetail component 分割 refactor** — 大型 file を 6-7 個に分割 (REVIEW_QUALITY.md §1)
- **Discord E2E test 自動化** — Playwright + test guild auto-provisioning (REVIEW_MISSING_FEATURES.md §2)
- **spec/security.md 新設** — multi-host TLS / mTLS / token rotation runbook (v0.3 roadmap)

## 関連

- レビュー全文: REVIEW.md / REVIEW_DESIGN.md / REVIEW_VULNERABILITY.md / REVIEW_IMPLEMENTATION.md / REVIEW_MISSING_FEATURES.md / REVIEW_QUALITY.md
- 修正 PR: 後述 (PR 作成後に URL 追記)
