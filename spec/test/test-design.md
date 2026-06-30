---
type: test
title: "テスト設計"
description: "Concordia の vitest ベーステスト設計。in-memory SQLite で LLM を呼ばない決定的検証を基本方針とし、40+ テストファイルでスキーマ/API/repo/provider/MCP/実プロセス spawn を網羅。CI では lint(tsc --noEmit)/vitest/build を実行し、spawn 伴うテストは 20s timeout を付与。"
service: concordia
domain: tooling
tags:
  - vitest
  - typescript
  - sqlite
  - spawn
  - claude
  - codex
  - persona
  - monitoring
status: implemented
updated: 2026-06-30
---


# テスト設計

ランナーは **vitest**（`npm test` = `vitest run`）。`vitest.config.ts` で
`CONCORDIA_DISABLE_CLAUDE=1`（テスト中に実 LLM を叩かない）。CI
（`.github/workflows/ci.yml`）で lint(tsc --noEmit) / vitest / build を実行。
方針は AIFormat [`RULE_TEST.md`](https://github.com/LUDIARS/AIFormat/blob/main/RULE_TEST.md)。

> Concordia は **Web サービス（マルチエージェント調整）** 種別。重視点は
> in-memory SQLite を用いた repo/API のロジックと、LLM を呼ばない決定的検証。

## 現状（実装済）
`tests/` に 40+ の vitest ファイル + `src/**/*.test.ts`。代表:
- スキーマ / マイグレーション: `schema.test.ts`
- API: `sessions-api.test.ts` / `stat-api.test.ts` / `machines-api.test.ts` /
  `chat-api.test.ts` / `setup-api.test.ts` / `admin-restart.test.ts` / `admin-state.test.ts`
- repo / ロジック: `rules-repo.test.ts` / `personas-repo.test.ts` /
  `rule-handler-guard.test.ts` / `quiet-hours.test.ts` / `role-predict.test.ts` /
  `dispatcher.test.ts` / `report-generator.test.ts` / `config.test.ts`
- provider: `claude-code-provider.test.ts` / `codex-cli-provider.test.ts`
- MCP: `mcp-core-server.test.ts`
- processes: `processes.test.ts`（実プロセス spawn を伴う → per-test 20s timeout）
- Discord: `egress-filters.test.ts` / `formatter.test.ts`
- 終了フロー: `end-session-flow.test.ts` / `repo-change-watcher.test.ts`

## 種別ごとの観点（充実とみなす対象）
### ビルド / lint
- `npm run lint`（tsc --noEmit）/ `npm run build`（tsc + web vite）を CI で。

### ユニット / 統合（in-memory SQLite, LLM 無効）
- スキーマ migration の冪等（再適用で壊れない）。
- 各 repo の CRUD・partial unique（persona 排他、transcript seq 冪等）。
- API の認可 / 入力検証 / dispatcher のルーティング。
- rule engine の発火条件・cooldown・guard。

### 実プロセス系
- `processes.test.ts` は実 node プロセスを spawn/kill。CI runner で遅いため
  spawn を伴うテストは **per-test 20s timeout** を付与する（ローカル Windows で
  pass しても CI Linux で 5s 既定を超過しうるため）。

### 注意
- LLM を呼ぶ経路は `CONCORDIA_DISABLE_CLAUDE` で無効化して決定的に検証する。
- Discord 機能は env が無ければ no-op（DB を touch しない）前提でテストする。
