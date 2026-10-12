---
task: delegation-terminal-report-guard
project: Concordia
kind: 実装
status: review
created: 2026-10-12T00:00:00.000Z
source_session: lictor-4c7b5ed7-aa5b-4ea8-980f-77e4a3a919f5
memory_links:
  - actio:c503eeb2-5e3b-4afe-8e18-db25f99a9fff
---

# 委託状態照会と終端報告を安全に分離する (#96、方式 1+2)

## 要件

spec/feature/delegation.md「状態照会と終端報告の分離」「completed 報告の成果証跡」

## 分解

- [x] `src/delegation/status-report-policy.ts`: 照会ビュー・証跡ポリシー・案内文の正本
- [x] `src/api/delegation.ts`: `GET /runs/:id/status` (読み取り専用)、 終端済み再送応答に `terminal` / `correctable`、 invalid_body に `query_hint`、 completed の証跡検査を全委託へ
- [x] `src/delegation/completion-evidence.ts`: branch 免除 run 用の `verifyBranchExemptCompletion` (成果の記述必須、 拒否時も run は書き換えない)
- [x] 案内文の統一: `persona-context.ts` / `run-watchdog.ts` / `unstarted-run.ts`
- [x] 契約 `dsr-C-1` / `dsr-C-2` (augur.contracts.json + 述語モジュール)
- [x] 単体・API テスト (誤確定の再現テストを含む)
- [x] spec、 domain specRefs、 cc.acceptance.json の implementations

## 範囲外

status enum・既存 run の状態遷移・委託テンプレート定義の変更。 parttimer / implementation の inject テンプレ本文の書き換え。
