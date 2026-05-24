# Concordia — 不足機能評価 (2026-05-17)

評価: **B-**

### F1 — F7 (v0.1 目標) 完成度

| 機能 | 実装 | 評価 | 備考 |
|------|------|------|------|
| **F1. セッション登録** | ✅ | A | `POST /v1/sessions` + lost candidates 返却. 完全. |
| **F2. 進行共有** | ✅ | A | `POST /v1/sessions/:id/event` + `PATCH /v1/sessions/:id`. event accumulation 完全. |
| **F3. 終了レポート** | ✅ | B+ | `DELETE /v1/sessions/:id` で LLM 要約 + 構造化生成. 単, 30s timeout 同期 (HTTP handler 内) は UI freeze 危険. async に refactor 必要. |
| **F4. ロスト検知** | ✅ | A | src/sweeper.ts:36-112 で active→lost→abandoned→purge 状態機械完璧. heartbeat チェック + jsonl recovery. |
| **F5. ロスト引継ぎ** | ✅ | A | SessionStart 時 lost candidates 提示, `POST /v1/sessions/:id/resume` で前 task 継承. |
| **F6. 並列 worktree** | ⚠️ | B- | provider 抽象は ready だが, **actual injection 未動作**. claude-code provider (`src/providers/claude-code.ts:52-78`) の additionalContext 計算はあるが, hook 側で `CONCORDIA_ADDITIONAL_CONTEXT` env で受けて prompt に注入する tool 未確認. API 応答には worktree suggestion 含むが, 実 CLI hook wrapper (tools/concordia-hook.mjs) がこれを handle しない可能性. |
| **F7. Web monitor** | ✅ | A- | Vite + Foundation UI で session list / timeline / report preview 提供. observability pages 追加 (web/src/pages/Catalog.tsx, Errors.tsx, Reviews.tsx). 単, 管理画面 (catalog 修正, rule 追加) は Web UI なしで API raw call 依存. |

### observability 新規機能 (Excubitor 統合)

| 機能 | 状態 | 評価 | gap |
|------|------|------|-----|
| **catalog 管理** | partial | C | services.yaml read-only. Web UI から追加/修正/削除不可 (計画: v0.2). |
| **error rule** | ✅ | B+ | rule create/list/patch endpoint あり. 単, regex validator なし (ReDoS 危険). |
| **auto-fix runner** | ✅ | B | claude CLI spawn + git workflow. 単, verify_result (health probe outcome) 未充填. |
| **investigate mode** | ✅ | B | read-only 分析モード実装. revert safeguard あり. |
| **error detector** | ✅ | B | log bus subscribe + rule matching. 30s reload latency 許容可. |
| **docker control** | ✅ | A- | service start/stop/restart endpoint. docker-compose.ts で docker-compose 連携. |
| **service liveness** | ⚠️ | C | schema に liveness_history テーブルあるが, probe 実装未発見 (probe runner / endpoint config なし). |

### 主要 gap

1. **catalog Web UI 管理画面未存在**
   - サービス追加/修正は services.yaml raw edit のみ.
   - 推奨: Concordia web frontend に "Add Service" form (auto_fix.enabled, branch_prefix 等).

2. **rule pattern validator**
   - regex ReDoS 危険に対する input guard なし.
   - 即時 add safe-regex2 検証.

3. **verify_result 未充填**
   - auto_fix_runs.verify_result は health probe 結果を保存する設計だが, runner で populate せず.
   - 推奨: probe endpoint 呼出 → HTTP 200/latency 記録.

4. **Gemini / Codex provider**
   - spec では v0.2 stub だが, まだ skeleton のみ (gemini-cli.ts, codex-cli.ts は throw NotImplementedError).
   - v0.2 roadmap に含む.

5. **observability setup.md**
   - インストール後 observability 機能を有効化する steps が README にない.
   - 推奨: docs/observability-setup.md 追加 (bootObservability 環境変数, catalog.yaml 例).

### 優先度

**Critical (v0.1.x hotfix):**
- regex validator + ReDoS guard

**High (v0.1.1):**
- verify_result populate
- rule reload 即時 trigger (event bus)

**Medium (v0.2):**
- catalog Web UI
- observability ドキュメント化
