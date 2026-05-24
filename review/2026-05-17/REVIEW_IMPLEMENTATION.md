# Concordia — 実装品質レビュー (2026-05-17)

評価: **B+**

### 良い点

1. **モジュール分離 & 責務明確化**
   - `src/observability/` subdirectory に catalog, auto_fix, log, scanner, control を階層別に整理 (1427 行).
   - 各モジュールが drizzle-orm 型安全確保 (`src/observability/db/schema.ts` の sqliteTable 定義).
   - `src/observability/auto_fix/runner.ts` vs `src/observability/auto_fix/investigate.ts` が同一 safeguard pattern を共有しつつ, intent が明確 (fix vs analyze).

2. **型安全性**
   - TypeScript strict mode (`tsconfig.json`).
   - Zod schema 活用: `StartSchema` (`src/processes.ts:18-26`), `ControlBodySchema` (`src/observability/index.ts:40-42`).
   - 単, `db().all(drizzleSql` の raw SQL 結果は `as Array<Record<string, unknown>>` キャストで一部 type erasure 発生 (`src/observability/index.ts:100, 134`).

3. **エラー処理堅牢性**
   - rule reload の regex compile 失敗 catch & warn (`src/observability/log/error-detector.ts:77-78`).
   - git コマンド失敗 catch & continue (`src/observability/auto_fix/runner.ts:78-79`): "branch already exists" 想定状況.
   - process spawn の stdio capture (`src/observability/auto_fix/runner.ts:80-86`) で最終 exit code / output 抽出.

### 重複 & 改善点

1. **UUID 生成パターン不一致**
   - `src/observability/auto_fix/runner.ts:64` — `db().run(sql` ... `${runId}` で直接変数代入.
   - `src/observability/auto_fix/investigate.ts:63` — 同一パターン.
   - 問題: drizzle schema (`src/observability/db/schema.ts:115`) で `id: text('id').primaryKey().$defaultFn(() => randomUUID())` 宣言だが, insert 時 app で uuid 生成後 SQL に渡す. 両者動くが, schema の $defaultFn が dead code.
   - 対応: `INSERT ... DEFAULT VALUES` で DB に生成委任, または schema の $defaultFn 削除 & app 側のみで生成.

2. **rule reload latency**
   - `src/observability/log/error-detector.ts:34` — RELOAD_INTERVAL_MS = 30_000 (30 秒).
   - 新 rule を `POST /v1/error-rules` で生成後即座に log マッチさせるには最大 30 秒待ち.
   - 対応: rule create endpoint で reloadRules() を sync 呼出, または event bus trigger.

3. **error_task 状態重複**
   - `src/observability/db/schema.ts:102` — error_tasks.state (open/ack/resolved/...)
   - `src/observability/db/schema.ts:107` — error_tasks.auto_fix_state (null|"running"|"fixed"|...)
   - 問題: 同一 error に 2 個の状態カラム → sync 合わせ困難.
   - 対応: auto_fix_state 削除, auto_fix_runs.state のみ参照 (または view で統合).

4. **catalog watcher と scanner の競合**
   - `src/observability/catalog/watcher.ts:39` — services.yaml ファイル変更検知 → syncCatalog().
   - `src/observability/scanner/loop.ts:65` — 60 秒毎 docker / git スキャン → syncDockerInstances().
   - 両者同時に syncCatalog 呼べば DB lock 待ち. lock-free でないが safe, latency 増加.
   - 対応: watcher の syncCatalog 呼出前に既存 scan 完了を待つ.

### 部分的問題

1. **regex 検証不足** (セキュリティ section でも指摘)
   - rule pattern の regex 構文検証なし → ReDoS 危険.
   - 対応: safe-regex2 ライブラリ追加 (4KB, npm trusted).

2. **inline helper 関数**
   - `runClaudeCli()`, `execCapture()`, `revertIfDirty()` が runner.ts / investigate.ts 内に重複定義.
   - 対応: `src/observability/utils.ts` に抽出.

3. **fixture / test coverage**
   - observability 層全体 (catalog, auto_fix, scanner) に単体テストなし.
   - error-detector の rule matching ロジックも test 不十分.
   - 対応: vitest + SQLite in-memory で core scenarios テスト.

### 改善機会

1. **Drizzle transaction 活用**
   - error_task と auto_fix_run の upsert を atomic transaction で.
   - 現在は 2 つの separate `db().run()` 呼出.

2. **verifyResult 充填**
   - `auto_fix_runs.verify_result` (`src/observability/db/schema.ts:130`) は NULL のまま.
   - health probe 結果を JSON で保存 (例: `{ status: 200, responseTime: 123 }`).

3. **rule 優先度 / 重複回避**
   - 現在 error-detector は全 active rule を順次 matching (`src/observability/log/error-detector.ts:84-135`).
   - 規則 100+ なら latency 増加. 規則優先度カラム追加推奨.
