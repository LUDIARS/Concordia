# AUTOFIX (Concordia / 2026-05-25)

## 概要

- 修正ファイル数: 0
- 変更行数: +0 / -0
- カテゴリ別件数: lint=0 / typo=0 / unused_import=0 / dead_code=0 / gitignore=0 / toc=0 / critical_high=0
- 関連 PR: なし

本日の Concordia レビューで自動修正対象として確定したものはありません。Critical/High は 0 件、Medium 指摘 (CONTRIBUTING / SRE runbook / 性能目標) は新規ドキュメント設計が必要なため bounded 自動修正の対象外として「手作業に回した指摘」へ送ります。

## カテゴリ別

### lint warnings (0 件)

(該当なし)

### typo (0 件)

(該当なし)

### 未使用 import (0 件), dead code (0 件), .gitignore 漏れ (0 件), TOC ずれ (0 件)

(該当なし)

### Critical / High 修正 (0 件)

(該当なし — Critical/High 0)

## フラグしたが手作業に回した指摘

- `docs/CONTRIBUTING.md` 新設 — PR workflow / test 規約 / provider 追加手順 / spec 同期ルール (REVIEW_QUALITY.md §3)
- `CLAUDE.md` / `spec/service-schema.md` の 5/24〜25 新機能反映 (session_task_records / admin_state / idle-trigger / repo-change-watcher / branch conflict / session_id priority) (REVIEW_QUALITY.md §3)
- `docs/deploy.md` (Blue-Green/Canary/Rollback runbook、sqlite WAL multi-process safety) (REVIEW_IMPLEMENTATION.md §2)
- `spec/sre.md` 新設 — SLI/SLO 目標値 (p50/p95/p99 latency, max concurrent sessions) + benchmark CI 計画 (REVIEW_QUALITY.md §4)
- `admin_audit_log` テーブル設計 — DB schema migration v13 + AdminState setter wiring (REVIEW_MISSING_FEATURES.md §2)
- Prometheus exporter (`/v1/metrics`) — monitoring stack 選定が必要 (REVIEW_MISSING_FEATURES.md §2)
- Multi-host Tailscale 対応の mTLS 設計 — architecture review が必要 (REVIEW_MISSING_FEATURES.md §1)
- Provider stub (gemini-cli / codex-cli) の parseTranscript 実装 — 外部 spec 待ち (REVIEW_MISSING_FEATURES.md §1)

## 関連

- レビュー全文: [REVIEW.md](REVIEW.md) / REVIEW_DESIGN.md / REVIEW_VULNERABILITY.md / REVIEW_IMPLEMENTATION.md / REVIEW_MISSING_FEATURES.md / REVIEW_QUALITY.md
- 修正 PR diff: なし
