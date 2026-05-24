# Concordia — Review Summary (2026-05-17)

LUDIARS 自動コードレビュー (AIFormat §5 準拠). 対象 ref は `013a922` (HEAD, `chore(claude-runner): make timeout env-configurable`). 直近 6 commits で Excubitor 統合 + Web UI 拡張 + バグ修正.

| カテゴリ | 評価 | 主要所見 |
|---------|------|---------|
| Design          | A- | Excubitor 統合による observability 機能の吸収は責務が明確 (catalog/auto_fix/log). provider interface 抽象保持も良い. 一方, 新規 observability layer の catalog_loader → service control の流れで error-task と auto_fix_runs が双方向参照し, intent が散在. |
| Vulnerability   | C+ | **新規リスク**: `POST /v1/error-rules` (src/observability/index.ts:304-318) で UUID は randomUUID() で安全だが, pattern の regex 妥当性検査なし (ReDoS risk). `POST /v1/error-tasks/:id/auto-fix` (src/observability/index.ts:259-277) は loopback 前提なので大はリスクだが, Tailscale 対応前に validator 層を入れるべき. WS Origin 検証は前回指摘通り未修正. |
| Implementation  | B+ | observability の 1400+ 行が well-organized. logger 統一 (pino), db schema 型安全 (drizzle). 前回指摘の `safeParse` 重複は未修正. 新規: src/observability/auto_fix/runner.ts:65-68 の UUID INSERT で $defaultFn の drizzle 機構を使わず直接 SQL uuid 引数 (型安全性低下). error_detector の rule reload は 30s interval だが, 新規 rule create 直後の latency 未考慮. |
| Missing Features| B- | observability canvas / reviews page の UI は出ているが, catalog.services を edit する管理画面がない (read-only). auto_fix_runs.verify_result の populate が実装されていない (NULL のまま). |
| Quality         | B+ | テスト計 14 本, うち 3 本は fixtures なし ad-hoc. observability auto_fix runner は 400+ 行で単体テスト不在 (起動者 config.ts は 66 行で堅実). error_detector の regex compile 失敗時の warn log は良いが, invalid pattern の UI feedback がない (rule 作成ユーザは知らず). |

## Weighted score
- Design 25% × A- (90) + Vulnerability 20% × C+ (75) + Implementation 20% × B+ (85) + Missing 15% × B- (78) + Quality 20% × B+ (85) = **83.1 / 100** (前回 83.7)

## トップ 5 アクションアイテム (優先順)
1. **`/api/v1/error-rules` の regex pattern validator 実装 + ReDoS 検査** — `src/observability/index.ts:304-318`, compile 失敗を API 応答で返却
2. **auto_fix_runner の UUID INSERT を drizzle $defaultFn に統一** — `src/observability/auto_fix/runner.ts:65-68` + `src/observability/auto_fix/investigate.ts:63-66`
3. **catalog watcher と error_detector の rule reload を同期** — error create 後の detect latency を <5s に短縮 (background task or event bus)
4. **前回の `safeParse` / `nowSec` 重複を共通 util に移行** — `src/shared/util.ts` 新設, dispatcher/sessions/chat/personas から参照
5. **observability/auto_fix セクションの単体テスト追加** — runner.ts / investigate.ts / error-detector.ts は現在 0 カバレッジ
