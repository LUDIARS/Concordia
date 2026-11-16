---
type: plan
title: "仕様の体系化 — 2026-11-16 棚卸しと処置"
description: "Concordia spec/ の棚卸し結果 (重複・矛盾・古い記述・置き場所・索引の欠落)、この整理で行った処置、未解決の候補と判断者を記録する。"
service: concordia
domain: session-coordination
status: implemented
related:
  - ../README.md
  - ../architecture/ddd.md
updated: 2026-11-16
---

# 仕様の体系化 — 2026-11-16 棚卸しと処置

neco 指示 (2026-11-16):「Cc の仕様を整理して体系化、メジャーを上げる」。本書は整理 PR の記録で、
索引そのものは [spec/README.md](../README.md) が持つ。

## 対象境界

- 対象: `spec/README.md`、`spec/feature/*.md` の frontmatter `domain:` と冒頭の所属ドメイン行、
  `spec/domains/*.domain.json` の `specRefs` への追記、実装と食い違う記述 1 件 (FAQ の RWF)。
- 対象外: コード・テスト・`cc.acceptance.json`・`membership`・コードの `@implements`
  (いずれも変更しない)。ファイルの移動・改名はしない (参照切れを出さないため)。
- 並行担当が変更中のため本文に触れない: `feature/autonomous-work-continuation.md`、
  `feature/task-linked-followup.md` (索引には載せる)。生成物の `feature/domain-taxonomy.concordia.md` も手で直さない。
- 実装の挙動は変えない。

## 棚卸し結果 (整理前 → 整理後)

| 観点 | 整理前 | 整理後 |
|---|---|---|
| どのドメインの `specRefs` からも参照されない feature | 53 / 192 | 0 |
| frontmatter はあるが `domain:` が空の feature | 19 | 0 |
| `domain:` が実在しないドメイン名 (`task-management` `lifecycle` `runtime` `interface` `release-coordination`) | 5 | 0 |
| `domain:` が `specRefs` の所有ドメインのどれとも一致しない (例: `governance` と書かれ `director-patrol` が参照) | 63 | 0 (本文に触れない 3 件を除く) |
| 冒頭に所属ドメインを明記した feature | 0 | 189 (本文に触れない 3 件を除く全件) |
| README の feature 一覧に載る feature | 13 | 192 (全件、ドメイン別) |
| spec 内の壊れた相対リンク (tasks 以外) | 2 | 1 (生成物、下記 U-5) |
| frontmatter を持たない feature | 37 | 37 (冒頭行のみ追加。下記 U-4) |

数値は棚卸しスクリプト (domain.json の `specRefs` と js-yaml で読んだ frontmatter の突合、相対リンクの存在確認) による。

## 行った処置

1. **体系の正本を domain.json に定めた。** README に「ドメイン → feature → UX → 不変条件 ID」の索引を置き、
   ddd.md の戦略分類 (コア 2 / 下位責務 / 支援 / 技術境界) で章を分けた。ddd.md に載らない 20 ドメインは
   「未分類」として並べ、分類は決めていない (ddd.md「コア候補の採否や境界変更は責任者が判断」)。
2. **未参照の feature 53 件を所有ドメインの `specRefs` に追加した** (下表)。所有先は文書の題名・本文・
   既存の frontmatter から判断した。
3. **feature の frontmatter `domain:` と冒頭の `> 所属ドメイン:` 行を `specRefs` の写しにした。**
   複数ドメインが参照する 43 件は配列で書き、もとの値が所有者に含まれる場合はそれを先頭にした。
4. **FAQ の RWF 記述を実装に合わせた。** 「`plugins/concordia-rwf/` として動的 import / submodule 化」は、
   設定 `workflow.rwf_plugin_path` が廃止済み (`src/config/settings/definitions/operations.ts`) で
   `plugins/` も submodule も無い現状と食い違っていた。
5. **管制セッションの欄を README に用意した** (別担当の `spec/feature/control-session.md` が入る場所)。

### specRefs に追加した feature (ドメイン → 文書)

| ドメイン | 追加した feature |
|---|---|
| `agent-delegation` | [subsidiary-delegation.md](../feature/subsidiary-delegation.md) |
| `chat-platforms` | [ambient-listener.md](../feature/ambient-listener.md) · [blackbox-chat-engine.md](../feature/blackbox-chat-engine.md) · [boyaki-channel.md](../feature/boyaki-channel.md) · [discord-control-ui.md](../feature/discord-control-ui.md) · [discord-excubitor-commands.md](../feature/discord-excubitor-commands.md) · [discord-forum-migration.md](../feature/discord-forum-migration.md) · [discord-lictor-relay.md](../feature/discord-lictor-relay.md) · [discord-session-direct-inject.md](../feature/discord-session-direct-inject.md) · [discord-session-task-post.md](../feature/discord-session-task-post.md) · [discord-ui-pr-b.md](../feature/discord-ui-pr-b.md) · [participants.md](../feature/participants.md) · [reaction-workflow.md](../feature/reaction-workflow.md) · [slack-platform.md](../feature/slack-platform.md) · [test-forum-controls.md](../feature/test-forum-controls.md) · [working-indicator.md](../feature/working-indicator.md) |
| `director-patrol` | [director-issue-scout.md](../feature/director-issue-scout.md) · [director.md](../feature/director.md) |
| `federation` | [federation-link.md](../feature/federation-link.md) · [federation-role-settings.md](../feature/federation-role-settings.md) |
| `governance` | [cc-instruction-frequency.md](../feature/cc-instruction-frequency.md) · [develop-confirm-flow.md](../feature/develop-confirm-flow.md) · [genius-command-patterns.md](../feature/genius-command-patterns.md) · [inquiry.md](../feature/inquiry.md) · [memory-library.md](../feature/memory-library.md) · [plan-gate.md](../feature/plan-gate.md) · [pr-queue.md](../feature/pr-queue.md) · [session-contract.md](../feature/session-contract.md) · [staff-roster.md](../feature/staff-roster.md) · [vibes-mode.md](../feature/vibes-mode.md) |
| `harness-reliability` | [harness-status-card.md](../feature/harness-status-card.md) |
| `hook-transport` | [windows-console-focus-investigation.md](../feature/windows-console-focus-investigation.md) |
| `observability` | [context-observation-authority.md](../feature/context-observation-authority.md) · [error-pipeline.md](../feature/error-pipeline.md) · [operational-log-lifecycle.md](../feature/operational-log-lifecycle.md) · [runtime-function-metrics.md](../feature/runtime-function-metrics.md) |
| `persistence` | [transcript-frame-async-persist.md](../feature/transcript-frame-async-persist.md) |
| `personal-ai-budget` | [usage-budgets.md](../feature/usage-budgets.md) |
| `plan-approval-notification` | [question-option-codes.md](../feature/question-option-codes.md) |
| `project-code-registry` | [session-surface-project-codes.md](../feature/session-surface-project-codes.md) |
| `revisor-local-pr` | [pr-local-gate.md](../feature/pr-local-gate.md) |
| `runtime-orchestration` | [discord-runtime-recovery.md](../feature/discord-runtime-recovery.md) |
| `session-coordination` | [faq.md](../feature/faq.md) · [game-spec.md](../feature/game-spec.md) · [multi-provider.md](../feature/multi-provider.md) · [product-brief.md](../feature/product-brief.md) · [session-log-browser.md](../feature/session-log-browser.md) · [work-conflict-scope.md](../feature/work-conflict-scope.md) |
| `session-lifecycle` | [phase-compaction.md](../feature/phase-compaction.md) · [session-end-request.md](../feature/session-end-request.md) |
| `taskflow` | [actio-acting-for.md](../feature/actio-acting-for.md) |
| `tooling` | [spec-index.md](../feature/spec-index.md) |
| `web-access` | [ex-viewer-base.md](../feature/ex-viewer-base.md) |

## 未解決の候補 (この PR では変えていない)

確認や判断が要るため、推測で直さずに残す。判断者の欄が「責任者」のものは neco の判断事項。

| ID | 種類 | 内容 | 判断者・次の一手 |
|---|---|---|---|
| U-1 | 重複 | `task-workflow.md` (status: planned) は `task-workflow-v3.md` が「Markdown 正本と Memoria 突合の規則を置き換える」と宣言している。旧文書の status が置き換えを反映していない | 置き換えの範囲を確認し `superseded` 化または節単位の注記 (担当: taskflow) |
| U-2 | 重複 | `phase-compaction.md` (planned) と `session-compaction.md` (implemented) が同じ文脈再配置を扱い、後者から前者への言及が無い | どちらが現行か照合して一方を履歴化 (担当: session-lifecycle) |
| U-3 | 重複 | `usage-budgets.md` (ユーザー・チームの月次予算) と `personal-ai-budget.md` (個人の月間・報酬予算) の関係がどちらにも書かれていない | 関係 (置き換え / 併存) を確定し相互リンク (担当: personal-ai-budget) |
| U-4 | 書式 | frontmatter を持たない feature が 37 件 (`actio-acting-for.md` `bug-bounty.md` `task-workflow-v3.md` など)。spec-index に載らない | 文書ごとに type/title/status を足す後続 PR |
| U-5 | 壊れリンク | 生成物 `feature/domain-taxonomy.concordia.md` の `./domain-retune.md` が存在しない。手編集禁止 | 生成元 (domain-retune パイプライン) 側で直す |
| U-6 | 置き場所 | 実装指示書・調査記録が feature/ にある: `discord-ui-pr-b.md`・`discord-control-ui.md` (codex 向け実装指示)、`harness-status-card.md` (委託用実装スペック)、`windows-console-focus-investigation.md` (調査記録) | 移すなら `specRefs` と related を同じ PR で直す。tasks/ か plan/problem_logs へ |
| U-7 | 古い記述 | status が planned / draft の feature 70 件、status なし 42 件、非標準の値 (`implementation` `wip` `active` `investigating` `partially-implemented`) が残る。実装済みかどうかは本整理で照合していない | ドメイン担当が実装と照合して status を更新する |
| U-8 | 分類 | ddd.md の戦略分類に載らないドメインが 20 件 (bug-bounty・consultation・daily-goal-run・work-modes など) | ddd.md の分類表への追記は責任者が判断 |
| U-9 | 精査 | 本整理は機械的な突合 (所属・リンク・frontmatter) と目に付いた食い違いの修正まで。feature 本文どうしの矛盾の全件精査はしていない | ドメインごとのレビューで扱う |

## 復旧方法

この整理は文書と domain.json の `specRefs` 追記だけで、コードの挙動を変えない。
戻すときはマージコミットを `git revert` する。`specRefs` の追記だけを戻したいときは
`spec/domains/*.domain.json` の差分だけを revert すればよい (feature 側の写しは README の手順で直す)。
