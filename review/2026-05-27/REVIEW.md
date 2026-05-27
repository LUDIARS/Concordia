# Concordia — Review Summary (2026-05-27)

LUDIARS 自動コードレビュー (AIFormat web style 準拠)。
対象 HEAD: `23271d0` (`feat(discord): PR-A — Discord-UI bot 常駐 + session channel CRUD + chat egress + reaction`)。

| 項目 | 値 |
|------|-----|
| リポジトリ | Concordia (LUDIARS multi-agent session coordinator) |
| 対象ブランチ / PR | main (HEAD: 23271d0) |
| レビュー実施日 | 2026-05-27 |
| 対象コミット範囲 | 142538d (2026-05-25) 〜 23271d0 (2026-05-27) — 4 commits |
| 前回ベースライン | 2026-05-25 (13 commits ahead) |

## 主要差分 (5/25 → 5/27)

- **Discord Bot 統合 (PR #50)**: bot 常駐、session channel CRUD、chat/transcript egress、reaction 評価、webhook pool、idempotent layout setup
- **SessionDetail UI 全体改修 (PR #49)**: 縦スタック再構成 (header → repos → conversation → input → stat → buttons → toggles)、Enter=改行 / Ctrl+Enter=送信、手動 stat/title 依頼ボタン、project-codes.ts 新設
- **title-watcher 拡張 (PR #47)**: 初回 stat + prompt event で title-suggest 発火、per-session 30 秒 debounce 導入
- **title-watcher 洗練 (PR #48)**: prompt-trigger debounce 撤去、hasUndelivered による dedup 統一

## 総合評価 (Overall Assessment)

| # | レビュー観点 | 区分 | 評価 | 重大指摘数 | ドキュメント |
|---|------------|------|------|-----------|------------|
| 1 | 設計強度 | 共通 | A | 0 | REVIEW_DESIGN.md |
| 2 | 設計思想の一貫性 | 共通 | A | 0 | REVIEW_DESIGN.md |
| 3 | モジュール分割度 | 共通 | A | 0 | REVIEW_DESIGN.md |
| 4 | コード品質 | 共通 | B | 0 | REVIEW_QUALITY.md |
| 5 | コードレベル脆弱性 | 共通 | A | 0 | REVIEW_VULNERABILITY.md |
| 6 | テスト戦略・カバレッジ | 共通 | B | 1 | REVIEW_QUALITY.md |
| 7 | ライセンス遵守 | 共通 | A | 0 | REVIEW_QUALITY.md |
| 8 | ドキュメント完備性 | 共通 | B | 1 | REVIEW_QUALITY.md |
| 9 | 機能改善 | 共通 | A | — | REVIEW_MISSING_FEATURES.md |
| 10 | 不足機能 | 共通 | B | — | REVIEW_MISSING_FEATURES.md |
| 11 | Web 脆弱性 | Web | A | 0 | REVIEW_VULNERABILITY.md |
| 12 | ゼロトラスト | Web | B | 0 | REVIEW_VULNERABILITY.md |
| 13 | セキュリティ強度 | Web | B | 0 | REVIEW_VULNERABILITY.md |
| 14 | データスキーマ | Web | A | 0 | REVIEW_IMPLEMENTATION.md |
| 15 | SRE | Web | B | 1 | REVIEW_IMPLEMENTATION.md |
| 16 | パフォーマンス・ベンチマーク | Web | C | 1 | REVIEW_QUALITY.md |
| 17 | クロスプラットフォーム互換 | Web | B | 0 | REVIEW_QUALITY.md |

### 重大指摘の内訳

- Critical: 0
- High: 0
- Medium: 3 (Discord bot env 検証不完全 / SessionDetail input 制御文字対応なし / 性能テスト未積分)
- Low: 2 (Webhook 例外処理の冗長性 / spec/discord-ui-pr-b.md スコープ明確化要)

## トップ 5 アクションアイテム

1. **Discord bot env 値の堅牢性向上** — `readDiscordEnv` が enabled=true でも token/guildId を 1 つ欠いても silent no-op する。Warn ではなく Error で起動失敗させ、operator に気付かせる
2. **SessionDetail textarea の入力制約 (XSS / RTL 対策)** — 超長テキスト / 制御文字 / RTL marker (U+202E) の ingress チェックリストを spec に追加し frontend に実装
3. **benchmark CI / spec/sre.md 統一整備** — Discord bot + session channel CRUD / chat ingress-egress の latency SLI を定義、vitest bench で計測
4. **PR-B (Discord slash commands / AskUserQuestion bridge) の詳細設計読込** — spec/discord-ui-pr-b.md (343 行) を実装 checklist に落とし込み、Codex 実装への準備
5. **Webhook 例外復旧戦略明確化** — channel 削除 / webhook 無効化時の grace degradation (chat 投稿は meta channel fallback、egress skip with warn) をコードに明記

**評価基準:** A=ベストプラクティス / B=軽微改善 / C=リリース前要対応 / D=即時対応必要
