# 機能改善・不足機能レビュー (Concordia)

| リポジトリ | Concordia |
| --- | --- |
| 対象 HEAD | 23271d0 |

## 1. 機能改善 (A)

| 機能 | 対象 Commit | 改善内容 | 効果 |
|------|-----------|---------|------|
| Discord UI | PR #50 (23271d0) | bot 常駐化、session auto-channel、webhook ingress/egress | Web UI 入力課題の解消。Discord 経由で即座にチャット可能 |
| SessionDetail UI | PR #49 (3820989) | 縦スタック再構成、textarea (Enter=改行 / Ctrl+Enter=送信)、手動 stat/title 依頼 | UX 直感化。PC/mobile 共通対応 |
| Title watcher | PR #47/#48 (1c49658 / 875970a) | 初回 stat + prompt event で title-suggest、30s debounce → hasUndelivered dedup 統一 | ターミナルタイトルが常に作業内容を反映。自動化と手動便宜の両立 |
| SessionDetail repos panel | PR #49 (3820989) | ActiveReposPanel + project-codes.ts で活動中 repo を chip 表示 | 複数 repo 並行作業のコンテキスト把握が即座 |

全て incrementally に追加した feature、product quality 向上。

## 2. 不足機能 (B)

| 機能 | 優先度 | 説明 | 実装難度 |
|------|--------|------|---------|
| **PR-B: Discord slash commands** | High | spec/discord-ui-pr-b.md (343 L) に詳細。/stat / /rename / /note / /inject 等 9 個 + modal / autocomplete / AskUserQuestion bridge | Medium (Codex 実装予定、Lictor 改修必要) |
| **Polls (Discord 2024)** | Low | Concordia pending_question を Discord embed Polls で poll UI 化。spec/discord-ui.md の「将来検討」にリスト | Low (future iteration) |
| **Webhook token rotation** | Medium | token 露出への対応自動 rotation (Discord API rotate 呼出 → DB update) | Low (単純ロジック) |
| **E2E test (Playwright / Cypress)** | Medium | Web UI + Discord bot (test guild 対象) 統合テスト。現在 unit test (vitest) のみ | High (fixture / workflow 複雑) |
| **Prometheus metrics** | Low | session / event / channel lifecycle metrics 露出 (op モニタリング) | Low (pino → prometheus adapter) |
| **Audit log table** | Medium | session lifecycle / admin action / rule apply の ACID audit 専用 table。現状 event 経由のみ | Low (table + API endpoint) |
| **TLS / mTLS (multi-host v0.3)** | High | Tailscale 越え時の encryption + mTLS。現在 loopback only | High (cryptography + configuration) |

## 評価

**機能改善: A** — PR #47/#48/#49/#50 はいずれも UX 直結の concrete 改善。product quality の顕著な向上。

**不足機能: B** — PR-B が設計完了段階 (spec/discord-ui-pr-b.md 343 L)、E2E/metrics は future iteration で自然。v0.2 ロードマップとの alignment 良好。
