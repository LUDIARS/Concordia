# Concordia — 品質保証レビュー (2026-05-17)

評価: **B+**

### 1. テスト戦略・カバレッジ

**現況:**
- 単体テスト 14 個 (vitest + better-sqlite3 in-memory):
  - chat-api.test.ts (14 行)
  - sessions-api.test.ts (195 行)
  - dispatcher.test.ts (179 行)
  - processes.test.ts (190 行)
  - rules-repo.test.ts (140 行)
  - 他: report-generator, personas-repo, role-predict 等
- **統合テスト:** なし (observability 層特に不足).
- **カバレッジ:** 推定 40-50% (core APIs + dispatcher, observability 除く).

**gap:**
1. `src/observability/auto_fix/runner.ts` (357 行) → **0 test**.
   - branch create → claude spawn → git diff → commit の critical path が untested.
   - 対応: mock service catalog + in-memory DB + spawn モッキングで runner の正常/エラー path テスト.

2. `src/observability/log/error-detector.ts` (151 行) → **0 test**.
   - rule matching logic (reloadRules + matchLine + upsertTask) 未テスト.
   - 対応: vitest で regex compile, keyword matching, dedup window 検証.

3. `src/observability/control/manager.ts` → **0 test**.
   - docker-compose.ts の actual spawn は環境依存 (docker available).
   - 対応: docker-compose コマンドの構成ロジックのみ unit test 可.

### 2. ライセンス遵守

**現況:**
- MIT license (LICENSE ファイル).
- 主要依存:
  - hono ^4.6.0 (MIT)
  - drizzle-orm ^0.36.4 (Apache 2.0)
  - better-sqlite3 ^11.7.0 (MIT)
  - ws ^8.20.0 (MIT)
  - zod ^3.24.0 (MIT)
  - pino ^9.5.0 (MIT)
- すべて MIT / Apache 2.0 (compatible).
- SPDX identifier なし (LICENSE はテキスト).

**チェック:**
- [x] 依存ライセンスすべて permissive.
- [x] GPL / AGPL なし.
- ✅ compliance 良好.

### 3. ドキュメント完備性

| 対象 | 状態 | 評価 | gap |
|------|------|------|-----|
| **README.md** | ✅ | A- | v0.1 overview, multi-provider spec, setup 含む. 単, Excubitor 統合後の observability section 未追加 (v0.1.1 で反映必要). |
| **spec/multi-provider.md** | ✅ | A | claude-code provider 完全, gemini/codex stub 明記. v0.2 ロードマップ明確. |
| **spec/service-schema.md** | ⚠️ | C | 存在するが内容 sparse. catalog の service object structure (auto_fix, cwd, branch_prefix 等) の JSON schema / 例必要. |
| **docs/hooks-claude-code.md** | ✅ | B | hook setup 例あり. 単, observability-setup.md 未存在 (bootObservability, catalog.yaml 例必要). |
| **JSDoc inline** | ✅ | A | すべての exported function に /** */ コメント. 階層別 (bootstrap, router, runner) の intent 明確. |
| **CLAUDE.md** | ⚠️ | C | .claude/ に CLAUDE.md なし. 推奨: developer onboarding ガイド. |

**推奨追加文書:**
1. `docs/observability-setup.md` — bootObservability 環境変数, catalog.yaml レイアウト, rule 作成例.
2. `docs/architecture.md` — observability/ 層のデータフロー図.
3. `spec/catalog-schema.json` — services.yaml の JSON schema (ajv validation 準備).

### 4. パフォーマンス・ベンチマーク

**現況:**
- load test なし.
- DB schema に index あり:
  - `session_id` on session_events (`src/observability/db/schema.ts:44`).
  - foreign key constraints on error_tasks, auto_fix_runs.
- rule matching は linear scan (O(n rules) × O(1 regex match per line)).
  - 活性 rule 100+ で latency 増加可能.

**想定ボトルネック:**
1. **rule reload latency** — 30s interval. 新 rule 追加後即時 matching <5 秒希望なら event-driven reload 必要.
2. **error-detector log.bus subscribe** — すべての service log が single bus を通過. 1000+ log lines/sec で callback 累積可能. worker threads or batching 推奨.
3. **report generator 30s sync call** — HTTP handler が block. async / background task に転換.

**推奨:**
- error-detector に batch window (100 行 or 1s) 追加後 upsert.
- report generator を `setImmediate()` + eventBus notify で async 化.

### 5. クロスプラットフォーム互換性

| 項目 | 状態 | 備考 |
|------|------|------|
| **Windows** | ✅ A | `src/observability/config.ts:11-36` に Git bash パス auto-detect (SourceTree, Git for Windows, WSL, msys2). 徹底的. |
| **macOS** | ⚠️ B | bash パスは `/bin/bash` 固定. M1/Intel 互換. ただテスト環境未確認. |
| **Linux** | ⚠️ B | node:child_process は POSIX 互換. docker-compose.ts は docker daemon 依存. コンテナ環境で動作. |
| **Node.js バージョン** | ✅ A | engines.node = ">=22.0.0". better-sqlite3 11.7.0 は node 18+ 対応. v22 ターゲット明確. |
