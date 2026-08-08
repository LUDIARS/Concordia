---
title: "TaskWorkflow と Revisor local PR の接続 (R1/R2)"
status: implemented
service: concordia
domain: session-coordination
updated: 2026-08-08
---

# TaskWorkflow と Revisor local PR の接続

Cc ワークフロー見直し (2026-08-08) のレビュー最重要指摘の修正。

## 問題 (接続断)

- goal-machine は `pr_records` (GitHub PR) だけを見るが、 Revisor 運用では push-guard
  により GitHub PR が作られない → local PR がマージされても confirm キュー投入・
  残作業チェック・自走が発火せず、 **ゴール判断が空転していた** (R1)。
- completion 黒箱の seed は「push も diff も無い → not-implementation」だが、
  Revisor 運用は push しないため実装完了が誤って棄却されやすかった (R2)。

## 実装

1. `findSessionLocalPr` (goal-machine): セッションの repo_origin + branch を提出時と
   同じ規則 (owner/repo 正規化・headRef 大小区別) で Revisor local PR に突合する。
   Revisor 停止中は null (誤って「PR 無し」メンションを出さない)。
2. `runGoalMachine` に `revisor` (RevisorLocalPrReader) を注入。 GitHub PR が無ければ
   local PR で判断し、 merged → 既存の confirm intake (冪等) / open → 待ち /
   closed → 人間判断、 と GitHub 分岐と同じ意味論で合流する。
3. **Revisor 終局通知での発火**: `session.inject` (source="revisor") を taskflow
   runtime が購読し、 マージ済みを確認できたときだけゴール判断+残作業チェックを走らせる。
   auto-merge がセッションの final_answer より後に来るケースを拾う。
4. completion 黒箱の `prState` を local PR 状態 (merged/open) で補完する。

## Non-goals

- local PR の `pr_records` への取り込み (別系統のまま。 spec/feature/pr-queue.md の
  「queue には混ぜない」方針を維持)
