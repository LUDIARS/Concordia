# 品質保証レビュー (Concordia)

| リポジトリ | Concordia |
| --- | --- |
| 対象 HEAD | 142538d |

## 1. テスト戦略・カバレッジ (B)

- 222 tests passing in 3.14s (vitest run)
- 新規 session_task_records / admin_state / stat_scheduler は unit coverage 良好
- Provider stub (gemini / codex) は throw NotImplementedError で実 unit なし
- E2E (Playwright/Cypress) 未導入
- coverage % 計測未実行 (`--coverage` option 未走らせ)
- timing-dependent (quiet-hours.test.ts) は時刻 mock

## 2. ライセンス遵守 (A)

- LICENSE (MIT) ファイル存在
- 依存: hono / zod / better-sqlite3 / drizzle-orm / pino / ws / js-yaml は MIT/ISC で互換
- NOTICE/THIRD_PARTY_LICENSES は npm publish 時に自動生成想定 (未配置だが配布 artifact 単体で要追加)

## 3. ドキュメント完備性 (B、重大指摘 1)

| 観点 | 評価 | 所見 |
| --- | --- | --- |
| README | B | 先頭 100 行で概要・セットアップ網羅 |
| spec/service-schema.md | B | API/schema 詳細を 300+ 行で網羅、OpenAPI 自動生成は未 |
| inline コメント | B | JSDoc 整備、complex logic にも説明 |
| CONTRIBUTING | **C (重大指摘)** | 未整備。新規機能追加/test 書き方/PR checklist を文書化 |
| 新機能更新 | B | 5/24〜25 追加 (session_task_records / admin_state / idle-trigger / repo-change-watcher / branch conflict / session_id priority) の CLAUDE.md 更新が未実施 |

### 重大指摘 1

**`docs/CONTRIBUTING.md` 新設 + `CLAUDE.md` の新機能反映** — PR workflow / test 規約 / provider 追加手順 / spec/service-schema.md 同期ルールを明記。

## 4. パフォーマンス・ベンチマーク (C、重大指摘 1)

| 観点 | 評価 | 所見 |
| --- | --- | --- |
| 性能要件明文化 | **C (重大指摘)** | SLI (p50/p95/p99 latency, throughput, max sessions) 未文書化 |
| ベンチマーク | C | 負荷試験/プロファイル無し、production 性能未計測 |
| プロファイリング | B | pino logger で I/O 観測可だが、mutex / WAL throughput 未測定 |
| 性能リグレッション | D | CI に benchmark check なし、手動 |
| 大規模データ | C | session_task_records upsert × large dataset 未検証 |

### 重大指摘 1

**SLI/SLO を spec/sre.md に定義 + benchmark CI 追加** — `vitest bench` 等で rule engine / stat scheduler / sessions API の主要 latency / throughput を CI で継続測定。

## 5. クロスプラットフォーム互換 (B)

- Node 22 pinned (engines)
- Web (React 19 + Vite): Chrome/Safari/Firefox 想定 (動作検証は手動)
- 文字コード/TZ: UTF-8 + unix sec 統一
- CI matrix (Node 18/20/22 × OS) は未実装

## 重大指摘合計

- テスト戦略: 0
- ライセンス: 0
- ドキュメント: 1 (Medium)
- パフォーマンス: 1 (Medium)
- クロスプラットフォーム: 0
