---
type: task
title: "Delegation 段階注入 (調査ブリーフ → 理由/Memoria/完了条件つき実装タスク)"
kind: 実装
status: done
service: concordia
created: 2026-08-09
updated: 2026-08-13
spec: spec/feature/delegation-staged-injection.md
problem_log: spec/plan/problem_logs/2026-08-09-delegation-initial-inject-stall.md
---

# Delegation 段階注入

実装委託が初回ターンで質問して停止する問題 (問題ログ参照) を、初回 inject の責務境界を
直すことで解消する。

## 完了した作業

- [x] `src/delegation/staged-injection.ts` — 文面の純関数
      (`decideStagedInjection` / `buildInvestigationBrief` / `buildFollowupInject` /
      `buildMemoriaTaskDraft` / `resolveWhy` / `buildMemoriaAttachmentNote`)
- [x] `src/delegation/staged-followup.ts` — 第2段階の冪等な配信 (Memoria 作成 + inject)
- [x] `src/delegation/persona-context.ts` — `DelegationPosture` で
      `approval` / `investigation` を排他に切り替え
- [x] `src/delegation/service.ts` — 適用判断、prompt file の `## Prompt` を調査ブリーフへ差し替え、
      `startupInjectText` も同じ本文にする (伏せたタスク本文を Discord surface へ漏らさない)
- [x] `src/delegation/contracts.ts` / `executor.ts` — `staged_injection` を LaunchResult →
      createRun / markRunSpawned へ伝播 (直起動・キュー払い出しの両経路)
- [x] `src/db/schema.ts` — forward-only migration 62 `delegation-staged-injection`
      (適用済み migration 41 の `COLUMN_ADDITIONS` は変更しない)
- [x] `src/db/delegation-repo.ts` — 列と `recordInvestigationReport` /
      `recordMemoriaTask` / `markStagedFollowupDelivered` (いずれも NULL ガード付き)
- [x] `src/api/delegation.ts` — `POST /runs/:id/investigated` と、接続ガード / inject 送出の共通化
- [x] `src/memoria/client.ts` — `taskApiUrl()` (契約済みの `/api/tasks/:id` のみ)
- [x] `src/admin/*` — `admin.delegation_staged_injection_enabled` (既定 true)
- [x] `src/bootstrap/core.ts` / `src/api/register-core.ts` — 配線
- [x] 回帰テスト
      (`staged-injection.test.ts` / `staged-followup.test.ts` /
      `persona-context.test.ts` 追記 / `api/delegation-staged-injection.test.ts`)
- [x] spec / 問題ログ
- [x] 最新 main (`45f5905`) へ rebase 統合。既存 migration 41〜61 は byte-for-byte 維持し、
      本タスク分を forward-only の 62 へ追加して `SCHEMA_VERSION = 62`。凍結台帳と
      スキーマ指紋も 62 を含む値へ更新。

## 残作業

- 本ブランチの local PR (#350) が rebase 前の head のまま止まっている →
  `spec/tasks/2026-08-09-local-pr-stale-head-retry.md`

## 意図的に対象外

- Claude native auto permission の allow/deny — Lictor #332 の責務。本 PR では触らない。
- delegation run watchdog の再有効化・閾値変更 — `run-watchdog.ts` は列も挙動も無変更。
- Memoria 本体の変更 — 既存の `POST /api/tasks` だけを使う。
- Web UI (設定画面) への露出 — `AdminState.snapshot()` には出るが画面追加はしていない。
