---
type: feature
title: "Concordia 仕様書"
description: "複数 AI エージェント（Claude Code / Gemini / Codex）のセッション協調・記録を行う Concordia の仕様ルートインデックス。ドメイン (spec/domains/*.domain.json) を正本に、ドメイン → feature → UX → 不変条件 ID の索引と、ドメイン外の資料への入口を示す。"
service: concordia
domain: session-coordination
tags:
  - typescript
  - discord
  - websocket
  - sqlite
  - relay
  - delegation
  - multi-provider
  - session-coordination
status: implemented
related:
  - architecture/ddd.md
  - ux/product.md
  - feature/work-modes.md
  - interface/service-schema.md
  - plan/spec-systematize-2026-11-16.md
updated: 2026-11-16
---

# Concordia 仕様書

複数 AI エージェント（Claude Code / Gemini / Codex）のセッション協調・記録・管制を
行う **Concordia** の仕様。AIFormat
[`FORMAT_SPEC.md`](https://github.com/LUDIARS/AIFormat/blob/main/FORMAT_SPEC.md)
を参照し、用途ごとの資料への入口を以下に示す。

## 読み方と正本

1. 利用者の問題・価値・回復シナリオは [ux/product.md](ux/product.md)。コアの
   [セッション協調](ux/session-coordination.md) と [作業委任](ux/agent-delegation.md) が下位の UX。
2. 境界・業務不変条件・開発手順は [architecture/ddd.md](architecture/ddd.md)、採用技術と原則は
   [Node.js 採用とサービス原則](architecture/nodejs-service-principles.md)。
3. **体系の正本は `spec/domains/*.domain.json`**。コードの所属は `membership`、そのドメインが
   従う仕様は `specRefs` が決める。下の「体系索引」と、各 feature 文書の frontmatter `domain:` と
   冒頭の「所属ドメイン」行は、この `specRefs` を写したものである。食い違ったら domain.json を正とし、
   写しの方を直す。
4. 作業の進め方 (対話・デイリーゴール・委託・パートタイマー・Director・相談・スプリント) の選び方は
   [feature/work-modes.md](feature/work-modes.md)。
5. 現在のタスク状態の正本は Actio。`spec/tasks/` は作業要件と過去の実施記録で、索引には含めない。

### 文書を足す・動かすときの手順

- 新しい feature を書いたら、所有するドメインの `specRefs` に追加し、frontmatter `domain:` と
  H1 直下の `> 所属ドメイン:` 行を同じ値にして、この索引の該当ドメインへ 1 行足す。
- 複数ドメインが参照する文書は、frontmatter `domain:` を配列で書く (順序は主たる所有者を先頭)。
- 文書を移動・改名するときは、domain.json の `specRefs`・コードの `@implements`・`cc.acceptance.json`・
  他文書のリンクを同じ PR で直し、参照切れが 0 であることを確かめる。
- 廃止・置き換え済みの文書は削除せず `status: superseded` / `retired` にし、「履歴扱い」へ載せる。
- 2026-11-16 の整理の棚卸し結果と未解決の候補は
  [plan/spec-systematize-2026-11-16.md](plan/spec-systematize-2026-11-16.md)。

## 構成

```
spec/
├── ux/          # プロダクトとコアドメインの UX 定義書（Pf/An 共通正本）
├── architecture/ # 採用技術・サービス原則、DDD の境界・不変条件・開発手順
├── domains/     # 体系の正本: コード所属 (membership) と従う仕様 (specRefs) の宣言
├── feature/     # 機能仕様。すべて 1 つ以上のドメインの specRefs から参照される
├── interface/   # API・schema 正本（service-schema.md）
├── data/        # SQLite スキーマ一覧（schema.ts 正本）
├── design/      # 個別設計資料
├── faq/         # 運用・設計上の補足説明
├── plan/        # 中長期計画・調査・問題記録 (ドメイン所属は任意)
├── setup/       # 起動・設定（用途別ガイド + hook 連携手順）
├── tasks/       # 作業要件と過去の実施記録（現在のタスク状態の正本は Actio）
└── test/        # テスト設計
```

## 業務不変条件 (横断)

ドメインをまたぐ `CC-INV-01`〜`CC-INV-08` は [architecture/ddd.md §業務不変条件](architecture/ddd.md#業務不変条件) が正本。
各ドメインに固有の `CC-*-INV-*` は、下の体系索引で所有ドメインの行に示す
(ID はその feature 文書の表・箇条書き・見出しで定義されているもの)。
UX シナリオ ID (`UX-CC-*`) は各 UX 文書が定義する。

## 新設予定・作業中の feature

| feature | 状態 | 所属ドメイン |
|---|---|---|
| 管制セッション — `spec/feature/control-session.md` | 2026-11-16 neco 指示「新しくメジャーに上げる前に Cc の管制セッションを作ろう」。別担当が実装中 (文書は実装 PR で追加) | 実装 PR で `specRefs` に登録して確定する |

> メジャーリリースは、この仕様整理 PR と管制セッション PR の両方がマージされてから切る。
> 管制セッションの文書が入ったら、この表の行を体系索引の所属ドメインへ移す。

## 体系索引 (ドメイン → feature → UX → 不変条件 ID)

分類は [architecture/ddd.md §戦略的な分類](architecture/ddd.md#戦略的な分類と既存コードへの対応) に従う。
括弧内は各文書 frontmatter の `status`。

### コア：セッション協調

#### `session-coordination`

[domain.json](domains/session-coordination.domain.json) — Core purpose: track concurrent AI coding agent sessions — register, share progress, detect lost sessions, re…

- feature:
  - [astra-with-sidecar.md](feature/astra-with-sidecar.md) — Astra With Sidecar (draft)
  - [delegation-spawn-target-validation.md](feature/delegation-spawn-target-validation.md) — 委託 spawn の着地検証とゾンビ回収
  - [faq.md](feature/faq.md) — Concordia FAQ (implemented)
  - [game-spec.md](feature/game-spec.md) — Omnipotens gameplay applicability and Concordia system spe… (not-applicable)
  - [goal-and-go.md](feature/goal-and-go.md) — ゴールアンドゴー (goal-and-go 自走継続) (implemented)
  - [goal-stop-question-guard.md](feature/goal-stop-question-guard.md) — ゴールを止める質問のガード
  - [human-response-confirmation.md](feature/human-response-confirmation.md) — 人間の応答がない確認ループを止める
  - [inject-context-gating.md](feature/inject-context-gating.md) — 対象と会話の確証に応じた主要 Inject (implementation)
  - [major-inject-editor.md](feature/major-inject-editor.md) — 主要 Inject 文面の編集と適用 (implementation)
  - [multi-provider.md](feature/multi-provider.md) — Concordia — Multi-Provider Spec (wip)
  - [product-brief.md](feature/product-brief.md) — Concordia product brief (Omnipotens baseline) (implemented)
  - [project-rules-inject.md](feature/project-rules-inject.md) — プロジェクト登録後の実装ポリシー / ルール inject (implemented)
  - [repository-search-capabilities.md](feature/repository-search-capabilities.md) — Repository search capability guidance (draft)
  - [session-auto-succession.md](feature/session-auto-succession.md) — コンテキスト量による自動引き継ぎと、リポ担当エージェントへの受け渡し (implemented)
  - [session-end-bounded-recovery.md](feature/session-end-bounded-recovery.md) — Explicit session end has a bounded recovery path (draft)
  - [session-language-guard.md](feature/session-language-guard.md) — 言語補正 — 英語に流れたセッションを日本語へ戻す
  - [session-log-browser.md](feature/session-log-browser.md) — Session log browser (implemented)
  - [session-work-phases.md](feature/session-work-phases.md) — セッションの設計・開始確認・実装・調整 (draft)
  - [shared-available-one-shot.md](feature/shared-available-one-shot.md) — Provider-neutral text generation (draft)
  - [shared-startup-context.md](feature/shared-startup-context.md) — 新規セッションへの最小共通コンテキスト (implemented)
  - [sidecar-lifecycle-model-refresh.md](feature/sidecar-lifecycle-model-refresh.md) — 常駐サイドカー・待機判定・モデル更新 (draft)
  - [task-linked-followup.md](feature/task-linked-followup.md) — Actio タスクに紐づく作業案内と継続 (draft)
  - [work-conflict-scope.md](feature/work-conflict-scope.md) — Work 衝突監視スコープ (target_project 宣言 + ルート除外)
  - [workplace-chat.md](feature/workplace-chat.md) — 職場チャットと相談の境界 (draft)
- UX: [session-coordination.md](ux/session-coordination.md)
- 設計・契約: [ddd.md](architecture/ddd.md)
- 不変条件 ID: `CC-LANG-INV-01〜03`

### コア：作業委任

#### `agent-delegation`

[domain.json](domains/agent-delegation.domain.json) — Delegation prompt context, seeded operating templates, and subsidiary harness policies for coordinating work…

- feature:
  - [astra-with-sidecar.md](feature/astra-with-sidecar.md) — Astra With Sidecar (draft)
  - [daily-vulnerability-intelligence.md](feature/daily-vulnerability-intelligence.md) — 日次CVE・ネイティブ依存・類似処理点検 (draft)
  - [delegation-profile-defaults.md](feature/delegation-profile-defaults.md) — Delegation model versions and adjustable effort (draft)
  - [delegation-spawn-target-validation.md](feature/delegation-spawn-target-validation.md) — 委託 spawn の着地検証とゾンビ回収
  - [delegation.md](feature/delegation.md) — Delegation Templates — 設計 (implemented)
  - [developer-toolset.md](feature/developer-toolset.md) — Cc 共通開発ツールセット (draft)
  - [implementation-worktree.md](feature/implementation-worktree.md) — Ccが作成する作業worktreeとActio参照 (draft)
  - [inject-context-gating.md](feature/inject-context-gating.md) — 対象と会話の確証に応じた主要 Inject (implementation)
  - [major-inject-editor.md](feature/major-inject-editor.md) — 主要 Inject 文面の編集と適用 (implementation)
  - [periodic-progress-report.md](feature/periodic-progress-report.md) — 委託・明示ゴールの10分進捗報告 (draft)
  - [project-harness-policy.md](feature/project-harness-policy.md) — プロジェクト別DDD・契約適用と復旧可能なハーネス
  - [shared-available-one-shot.md](feature/shared-available-one-shot.md) — Provider-neutral text generation (draft)
  - [sidecar-lifecycle-model-refresh.md](feature/sidecar-lifecycle-model-refresh.md) — 常駐サイドカー・待機判定・モデル更新 (draft)
  - [subsidiary-delegation.md](feature/subsidiary-delegation.md) — 子会社 Delegation — 設計 (planned)
  - [task-workflow-v3.md](feature/task-workflow-v3.md) — Task workflow v3.0 — Actio authority
- UX: [agent-delegation.md](ux/agent-delegation.md)
- 設計・契約: [ddd.md](architecture/ddd.md)
- 不変条件 ID: `CC-TF-EXEC-INV-01〜04`

### コアを実現する下位責務

#### `session-lifecycle`

[domain.json](domains/session-lifecycle.domain.json) — Concordia の session 行そのもの (登録 → patch → heartbeat → end/purge) を所有する層。

- feature:
  - [implementation-tools.md](feature/implementation-tools.md) — Implementation tool fast paths (implemented)
  - [inject-context-gating.md](feature/inject-context-gating.md) — 対象と会話の確証に応じた主要 Inject (implementation)
  - [major-inject-editor.md](feature/major-inject-editor.md) — 主要 Inject 文面の編集と適用 (implementation)
  - [phase-compaction.md](feature/phase-compaction.md) — フェーズ境界の文脈再配置 + コンテキスト残量の可視化 (planned)
  - [session-compaction.md](feature/session-compaction.md) — セッション・コンパクション (引き継ぎ型) — 設計 (implemented)
  - [session-end-bounded-recovery.md](feature/session-end-bounded-recovery.md) — Explicit session end has a bounded recovery path (draft)
  - [session-end-request.md](feature/session-end-request.md) — 発話による「セッション終了」
  - [session-fragment.md](feature/session-fragment.md) — フラグメントとストラクチャード — plan / vibes モードの撤廃後の運用 (implemented)
  - [session-process-reaper.md](feature/session-process-reaper.md) — セッション終了プロセスの回収 (reaper) (implemented)
  - [session-prompt-title.md](feature/session-prompt-title.md) — セッションタイトル (current_task) を人の指示から決める (implemented)
  - [session-shutdown.md](feature/session-shutdown.md) — セッション shutdown — session-end の最後に Lictor を確実に畳む (planned)
  - [session-work-phases.md](feature/session-work-phases.md) — セッションの設計・開始確認・実装・調整 (draft)
  - [workplace-chat.md](feature/workplace-chat.md) — 職場チャットと相談の境界 (draft)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `autonomous-continuation`

[domain.json](domains/autonomous-continuation.domain.json) — セッションを止めずにゴールへ進め続けるための自律継続層。

- feature:
  - [actio-pr-continuation.md](feature/actio-pr-continuation.md) — Actio PR evidence and continuation
  - [autonomous-work-continuation.md](feature/autonomous-work-continuation.md) — 自走継続 — 朝タスク仕分け + 停止セッション nudge (implemented)
  - [goal-and-go.md](feature/goal-and-go.md) — ゴールアンドゴー (goal-and-go 自走継続) (implemented)
  - [human-response-confirmation.md](feature/human-response-confirmation.md) — 人間の応答がない確認ループを止める
  - [idle-nudge.md](feature/idle-nudge.md) — Feature: idle-after-final-answer nudge (待機催促通知)
  - [periodic-progress-report.md](feature/periodic-progress-report.md) — 委託・明示ゴールの10分進捗報告 (draft)
  - [session-work-phases.md](feature/session-work-phases.md) — セッションの設計・開始確認・実装・調整 (draft)
  - [sidecar-lifecycle-model-refresh.md](feature/sidecar-lifecycle-model-refresh.md) — 常駐サイドカー・待機判定・モデル更新 (draft)
  - [task-linked-followup.md](feature/task-linked-followup.md) — Actio タスクに紐づく作業案内と継続 (draft)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `session-message-layer`

[domain.json](domains/session-message-layer.domain.json) — Projects Concordia session events into a durable display-ready work stream, exposes cursor/read-state APIs a…

- feature:
  - [actio-pr-continuation.md](feature/actio-pr-continuation.md) — Actio PR evidence and continuation
  - [session-end-inject-visibility.md](feature/session-end-inject-visibility.md) — 内部の終了指示をチャットへ投稿しない (implemented)
  - [session-message-layer.md](feature/session-message-layer.md) — Session message layer — canonical work stream (implemented)
  - [workplace-chat.md](feature/workplace-chat.md) — 職場チャットと相談の境界 (draft)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `taskflow-instructions`

[domain.json](domains/taskflow-instructions.domain.json) — セッションへ配るタスクワークフローの規範文言の正本。

- feature:
  - [deterministic-teardown.md](feature/deterministic-teardown.md) — 決定論終了と再キュー — タスクワーカー残留の根治 (planned)
  - [human-response-confirmation.md](feature/human-response-confirmation.md) — 人間の応答がない確認ループを止める
  - [sidecar-lifecycle-model-refresh.md](feature/sidecar-lifecycle-model-refresh.md) — 常駐サイドカー・待機判定・モデル更新 (draft)
  - [task-workflow.md](feature/task-workflow.md) — タスクワークフロー — 分解 → 委託実装 → 安定ブランチテスト → 自走 (planned)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `delegation-implementation-inject`

[domain.json](domains/delegation-implementation-inject.domain.json) — 実装委託の初回 inject (why + タスク本文 + Memoria 追跡タスク + 完了条件) の文面組み立てと Memoria 起票。

- feature:
  - [delegation-implementation-inject.md](feature/delegation-implementation-inject.md) — Delegation 実装委託の 1 通注入 — why + タスク + Memoria + 完了条件 (implemented)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `delegation-launch`

[domain.json](domains/delegation-launch.domain.json) — 委託 run の起動オーケストレーション (template 解決 → prompt 描画 → effort/model/runtime option 解決 → 段階注入判定 → spawn → run 行の記録)。

- feature:
  - [delegation-implementation-inject.md](feature/delegation-implementation-inject.md) — Delegation 実装委託の 1 通注入 — why + タスク + Memoria + 完了条件 (implemented)
  - [delegation-model-tiers.md](feature/delegation-model-tiers.md) — Delegation model tiers and quota substitution (draft)
  - [delegation-spawn-target-validation.md](feature/delegation-spawn-target-validation.md) — 委託 spawn の着地検証とゾンビ回収
  - [delegation.md](feature/delegation.md) — Delegation Templates — 設計 (implemented)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `delegation-parttimer-inject`

[domain.json](domains/delegation-parttimer-inject.domain.json) — パートタイマー (category=parttimer) 委託の inject。

- feature:
  - [delegation-parttimer-inject.md](feature/delegation-parttimer-inject.md) — パートタイマー inject — タスク本文を先頭に置き、終わり方を 1 系統にする (implemented)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `delegation-provider`

[domain.json](domains/delegation-provider.domain.json) — Delegation の論理 provider を実行経路へ解決する境界。

- feature:
  - [delegation.md](feature/delegation.md) — Delegation Templates — 設計 (implemented)
  - [goal-and-go.md](feature/goal-and-go.md) — ゴールアンドゴー (goal-and-go 自走継続) (implemented)
  - [interactive-codex-startup.md](feature/interactive-codex-startup.md) — 通常 Codex spawn の初期依頼と対話寿命
  - [shared-one-shot.md](feature/shared-one-shot.md) — Shared one-shot launch boundary
  - [shared-startup-context.md](feature/shared-startup-context.md) — 新規セッションへの最小共通コンテキスト (implemented)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `delegation-queue`

[domain.json](domains/delegation-queue.domain.json) — Delegation の実行キュー (同時実行上限 / FIFO 払い出し / claim + fencing token + outbox / 死んだ run のスロット解放)。

- feature: なし (コード所属のみの domain)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `director-inquiry`

[domain.json](domains/director-inquiry.domain.json) — Director 問診: 巡回が検出した停滞・失敗を、機械文の通知カードではなく読み取り専用の短命セッションの起動へ格上げし、そのセッションに Decision Request を組み立てさせる責務。

- feature:
  - [director-inquiry-session.md](feature/director-inquiry-session.md) — Director 問診セッション — 人間への問いかけを LLM セッションに作らせる (implemented)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `director-patrol`

[domain.json](domains/director-patrol.domain.json) — Director 由来の巡回機構と工程状態の投影。

- feature:
  - [approval-inbox.md](feature/approval-inbox.md) — 承認インボックス — 人間宛て未回答事項の一元化 (planned)
  - [curiosity-walk.md](feature/curiosity-walk.md) — 散歩セッション — 無関係な素材と他サービスへの興味から問いを起こす (implemented)
  - [director-goal-flow.md](feature/director-goal-flow.md) — Director ゴールフロー — 案件単位のゴール定義・工程自動進行・可視化 (planned)
  - [director-issue-scout.md](feature/director-issue-scout.md) — Director 課題スカウト — 上流推論・将来予測・前例照合による課題発見 (implemented)
  - [director-patrol.md](feature/director-patrol.md) — Director 巡回 — 30 分ごとのチーム監視と実装セッションの自動起動 (superseded)
  - [director-workflow.md](feature/director-workflow.md) — ディレクターワークフロー — 現場を回す人のワークロード定義とタスク整理 (superseded)
  - [director.md](feature/director.md) — Director — 原稿フロー進行と Genius 判断代理 (implemented)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `escalation-mode`

[domain.json](domains/escalation-mode.domain.json) — インフラ (Concordia / Revisor / Excubitor) が停止し通常ワークフローでは復旧そのものが進められない期間だけ、task 登録・worktree 分離の規律を外し、外した事実を記録に残す層。

- feature:
  - [cc-workflow.md](feature/cc-workflow.md) — Cc workflow injection (implemented)
  - [escalation-mode.md](feature/escalation-mode.md) — Escalation mode (implemented)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

### 支援：成果と外部依頼

#### `github-issue-workflow`

[domain.json](domains/github-issue-workflow.domain.json) — GitHub Issue の運用ラベル (既定 Cc) を起点に、修正の委託 → Revisor local PR の審査通過 → GitHub への push と PR 作成 → Issue へのリンク返却までを …

- feature:
  - [github-issue-workflow.md](feature/github-issue-workflow.md) — GitHub Issue ワークフロー — Cc ラベル起点の対応 → 審査 → GitHub PR (implemented)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `revisor-local-pr`

[domain.json](domains/revisor-local-pr.domain.json) — Revisor local PR review submission and session-authorized merge workflow.

- feature:
  - [local-pr-merge-authorization.md](feature/local-pr-merge-authorization.md) — local PR マージの認可
  - [pr-local-gate.md](feature/pr-local-gate.md) — PR local gate
  - [revisor-local-pr-submission.md](feature/revisor-local-pr-submission.md) — レビュー発火 — 作業ブランチの local PR 自動提出 (implemented)
  - [revisor-test-forum-sync.md](feature/revisor-test-forum-sync.md) — Revisor Test Workflow synchronization (implemented)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `domain-review`

[domain.json](domains/domain-review.domain.json) — Anatomia のコアドメイン / プログラムドメイン層を読み取り、対象プロジェクトの Discord 面へ投稿し、その返信をレビュー回答として台帳と plan の突合資料へ書き戻す。

- feature:
  - [domain-review-discord.md](feature/domain-review-discord.md) — Discord でのドメインレビュー — ドメイン情報の投稿と返信の取り込み (planned)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `delegation-commit`

[domain.json](domains/delegation-commit.domain.json) — 委託 run のコミット代行 (commit broker)。

- feature: なし (コード所属のみの domain)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

### 支援：運用・組織

#### `observability`

[domain.json](domains/observability.domain.json) — 自プロセスの観測レイヤー。

- feature:
  - [automatic-title-task-stop.md](feature/automatic-title-task-stop.md) — 自動タイトル変更タスクの停止 (draft)
  - [context-observation-authority.md](feature/context-observation-authority.md) — Lictor-owned transcript identity and bounded context obser… (draft)
  - [delegation-model-tiers.md](feature/delegation-model-tiers.md) — Delegation model tiers and quota substitution (draft)
  - [error-pipeline.md](feature/error-pipeline.md) — エラー集約パイプライン + 自動修正 (implemented)
  - [operational-log-lifecycle.md](feature/operational-log-lifecycle.md) — Operational log lifecycle — bounded cc-live retention (implemented)
  - [runtime-function-metrics.md](feature/runtime-function-metrics.md) — Runtime function metrics (implemented)
  - [shared-available-one-shot.md](feature/shared-available-one-shot.md) — Provider-neutral text generation (draft)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `governance`

[domain.json](domains/governance.domain.json) — Policy and workflow steering: a rule engine that proposes/enacts actions, PR queue reconciliation, role pred…

- feature:
  - [approval-inbox.md](feature/approval-inbox.md) — 承認インボックス — 人間宛て未回答事項の一元化 (planned)
  - [cc-instruction-frequency.md](feature/cc-instruction-frequency.md) — Cc頻出指示の集計とスキル整理 (draft)
  - [danger-command-approval.md](feature/danger-command-approval.md) — 危険なpushのWARNING承認特例 (draft)
  - [departments.md](feature/departments.md) — 部署 — 会社の下でセッショングループと処理を分ける (implemented)
  - [develop-confirm-flow.md](feature/develop-confirm-flow.md) — Develop confirm flow (implemented)
  - [genius-command-patterns.md](feature/genius-command-patterns.md) — Genius command-pattern の push 注入
  - [inquiry.md](feature/inquiry.md) — お伺い (inquiry) — セッションが次の一手を Cc に諮る決定論プロトコル (planned)
  - [memory-library.md](feature/memory-library.md) — Memory / Skill Library Hygiene (implemented)
  - [patrol-chat.md](feature/patrol-chat.md) — 巡回チャット — 素材起点のルール投稿・返信・追投稿 (implemented)
  - [plan-gate.md](feature/plan-gate.md) — プランゲート — 設問→設計→承認を Discord 上で行うプランモード (planned)
  - [planning-adjustment.md](feature/planning-adjustment.md) — 企画調整課 — 体験の言葉で相談から調整まで進める (draft)
  - [pr-queue.md](feature/pr-queue.md) — PR キュー (PR Queue) (implemented)
  - [question-session-retention.md](feature/question-session-retention.md) — 終了セッションの未回答質問
  - [session-contract.md](feature/session-contract.md) — セッション契約 (session contract) — 初回指示後に全作業条件を一括契約化する (planned)
  - [shared-available-one-shot.md](feature/shared-available-one-shot.md) — Provider-neutral text generation (draft)
  - [staff-roster.md](feature/staff-roster.md) — 社員名簿 (役職権限登録リスト) (implemented)
  - [tech-consultation.md](feature/tech-consultation.md) — 技術相談 — 事前ヒアリング・プライベート相談・Tabula への公開
  - [vibes-mode.md](feature/vibes-mode.md) — バイブスモード — 動作中のものをいじりながら確認する軽量レーン (retired)
  - [workplace-chat.md](feature/workplace-chat.md) — 職場チャットと相談の境界 (draft)
- 不変条件 ID: `CC-CONSULT-INV-01〜12`, `CC-DEPT-INV-01〜09`

#### `federation`

[domain.json](domains/federation.domain.json) — マルチ拠点連合 (本社 ⇄ 拠点 site)。

- feature:
  - [federation-link.md](feature/federation-link.md) — 連合リンク基盤 (マルチ拠点 Phase 0+1+2) (implemented)
  - [federation-role-settings.md](feature/federation-role-settings.md) — 連合ロールの設定を Concordia 内で完結させる
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `project-code-registry`

[domain.json](domains/project-code-registry.domain.json) — Concordia が所有する project code と Git repository の対応、検証済み登録 API/command、session/forum の動的解決を扱う。

- feature:
  - [implementation-tools.md](feature/implementation-tools.md) — Implementation tool fast paths (implemented)
  - [implementation-worktree.md](feature/implementation-worktree.md) — Ccが作成する作業worktreeとActio参照 (draft)
  - [project-code-registry.md](feature/project-code-registry.md) — Project code registry — Cc 所有の空初期レジストリ (implemented)
  - [project-harness-policy.md](feature/project-harness-policy.md) — プロジェクト別DDD・契約適用と復旧可能なハーネス
  - [project-notification-preferences.md](feature/project-notification-preferences.md) — プロジェクト別デプロイ・リリース通知設定 (implemented)
  - [session-surface-project-codes.md](feature/session-surface-project-codes.md) — セッション投稿タイトルのプロジェクトコード — 触っている全リポを載せる (planned)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `testing-traffic`

[domain.json](domains/testing-traffic.domain.json) — 再起動・起動テストの「一報 (claim)」を Concordia が正本として持ち、交通整備する層。

- feature:
  - [testing-traffic.md](feature/testing-traffic.md) — テスト交通整備 (testing traffic control)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `checkout-lock`

[domain.json](domains/checkout-lock.domain.json) — 登録 checkout を前進させてよいかを Revisor へ答える読み取り専用の照会層。

- feature:
  - [checkout-lock-api.md](feature/checkout-lock-api.md) — checkout lock 照会 API — 登録 checkout を前進させてよいかを Cc が答える (implemented)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `checkout-published-deploy`

[domain.json](domains/checkout-published-deploy.domain.json) — Revisor が登録 checkout を merge commit へ前進させた通知 (lifecycle event checkout_published) を既存の Revisor → Cc inject か…

- feature:
  - [checkout-published-deploy.md](feature/checkout-published-deploy.md) — checkout 前進後の deploy — checkout_published を受けて build と再起動へ繋ぐ (implemented)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `parttimer-review-scheduling`

[domain.json](domains/parttimer-review-scheduling.domain.json) — パートタイマーの定期レビューを、Delegation テンプレートと Timer Delegation の cron 定義で登録・移行する責務。

- feature:
  - [delegation.md](feature/delegation.md) — Delegation Templates — 設計 (implemented)
  - [task-branch-harness.md](feature/task-branch-harness.md) — 作業境界とブランチの二重確認 (draft)
  - [team-standup-and-review.md](feature/team-standup-and-review.md) — チーム朝礼と定例 — チームごとの定時報告と、人間同席のタスク棚卸し (superseded)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

### 汎用/支援の技術境界

#### `chat-platforms`

[domain.json](domains/chat-platforms.domain.json) — Bidirectional chat-platform integration that surfaces session state and accepts control input over Discord a…

- feature:
  - [actio-chat-transport.md](feature/actio-chat-transport.md) — Actioの通常チャンネル配送
  - [actio-pr-continuation.md](feature/actio-pr-continuation.md) — Actio PR evidence and continuation
  - [ambient-listener.md](feature/ambient-listener.md) — アンビエント リスナー — 人間の会話を傍聴して自然参加する (planned)
  - [astra-with-sidecar.md](feature/astra-with-sidecar.md) — Astra With Sidecar (draft)
  - [blackbox-chat-engine.md](feature/blackbox-chat-engine.md) — ブラックボックス チャットエンジン + 中央 Haiku 描画 (planned)
  - [boyaki-channel.md](feature/boyaki-channel.md) — ぼやき channel + meta channel 日本語ラベル (planned)
  - [cloud-observation.md](feature/cloud-observation.md) — クラウド作業の観測と確認フォーラム (draft)
  - [company-pin-sharing.md](feature/company-pin-sharing.md) — 会社内のピン止め・保存操作の共有 (draft)
  - [consultation-title-summary.md](feature/consultation-title-summary.md) — 公開相談の短いスレッド名 (draft)
  - [cost-observability.md](feature/cost-observability.md) — Session cost observability (implemented)
  - [departments.md](feature/departments.md) — 部署 — 会社の下でセッショングループと処理を分ける (implemented)
  - [developer-toolset.md](feature/developer-toolset.md) — Cc 共通開発ツールセット (draft)
  - [discord-control-ui.md](feature/discord-control-ui.md) — Discord コントロール UI — 仕様 (codex / 並行 session 向け) (planned)
  - [discord-excubitor-commands.md](feature/discord-excubitor-commands.md) — Discord からの Excubitor project 起動・再起動 (implemented)
  - [discord-forum-migration.md](feature/discord-forum-migration.md) — Discord フォーラム移行 — Session / Test / TaskWorkflow
  - [discord-image-ingress.md](feature/discord-image-ingress.md) — Discord 添付・embed のセッション取り込み (implemented)
  - [discord-lictor-relay.md](feature/discord-lictor-relay.md) — Discord ↔ Lictor 仲介リレー設計 (返信混線の根治) (implemented)
  - [discord-session-direct-inject.md](feature/discord-session-direct-inject.md) — Discord session channel 直接 inject — 仕様 (PR-B 後の小機能) (planned)
  - [discord-session-task-post.md](feature/discord-session-task-post.md) — Discord セッションのタスク本文投稿と pin (implemented)
  - [discord-ui-pr-b.md](feature/discord-ui-pr-b.md) — Concordia Discord-UI PR-B — 実装指示 (codex 向け) (planned)
  - [discord-ui.md](feature/discord-ui.md) — Concordia Discord-UI 統合 — 仕様 (PR-A) (implemented)
  - [explicit-artifact-relay.md](feature/explicit-artifact-relay.md) — Explicit artifact delivery under final-only output (draft)
  - [forum-discussion-type-first.md](feature/forum-discussion-type-first.md) — 議論タイプと Cc 自動起動の境界
  - [goal-stop-question-guard.md](feature/goal-stop-question-guard.md) — ゴールを止める質問のガード
  - [human-request-channel.md](feature/human-request-channel.md) — 人間依頼チャンネル (draft)
  - [meeting-respondent-handoff.md](feature/meeting-respondent-handoff.md) — 組織内の予定回答者リンク (draft)
  - [participants.md](feature/participants.md) — participants — 人間入力者の identity レジストリ + クロスプラットフォーム・ミラー (implemented)
  - [personal-ai-budget.md](feature/personal-ai-budget.md) — 個人の AI 予算 — 月間分と報酬分
  - [private-channels.md](feature/private-channels.md) — プライベートチャンネル — 指定した人だけが見られる Discord チャンネル
  - [reaction-workflow.md](feature/reaction-workflow.md) — Reaction Workflow — リアクション駆動の処理ディスパッチ (implemented)
  - [service-status-channel.md](feature/service-status-channel.md) — 子会社別のサービス稼働チャンネル (draft)
  - [session-end-inject-visibility.md](feature/session-end-inject-visibility.md) — 内部の終了指示をチャットへ投稿しない (implemented)
  - [session-message-webui-chat.md](feature/session-message-webui-chat.md) — Session message layer — later phases (WebUI chat, Lictor c… (partially-implemented)
  - [session-progress-monitor.md](feature/session-progress-monitor.md) — セッション進捗モニター (draft)
  - [session-work-phases.md](feature/session-work-phases.md) — セッションの設計・開始確認・実装・調整 (draft)
  - [slack-platform.md](feature/slack-platform.md) — Slack platform（Hub + session-per-channel） (implemented)
  - [sprint-dialogues.md](feature/sprint-dialogues.md) — スプリントの人間判断と会話 (draft)
  - [taskworkflow-orphan-reconciliation.md](feature/taskworkflow-orphan-reconciliation.md) — TaskWorkflow orphan thread recovery
  - [teams.md](feature/teams.md) — チーム — プロジェクト主単位の可視化・ルールスコープ・Discord カテゴリ (planned)
  - [test-forum-controls.md](feature/test-forum-controls.md) — テストフォーラムの操作面 — テスト開始 / マージ (active)
  - [working-indicator.md](feature/working-indicator.md) — 「作業中」インジケータ (implemented)
- UX: [meeting-respondent-handoff.md](ux/meeting-respondent-handoff.md)
- 不変条件 ID: `CC-DEPT-INV-01〜09`, `CC-INV-02`, `CC-INV-04`, `CC-ML-INV-01〜05`, `CC-PBUDGET-INV-01〜08`, `CC-PRIVCH-INV-01〜03`

#### `http-interface`

[domain.json](domains/http-interface.domain.json) — External access surfaces: the HTTP/Hono REST API that hooks report to, the MCP server, and the web monitorin…

- feature:
  - [actio-chat-transport.md](feature/actio-chat-transport.md) — Actioの通常チャンネル配送
  - [approval-inbox.md](feature/approval-inbox.md) — 承認インボックス — 人間宛て未回答事項の一元化 (planned)
  - [command-script-catalog.md](feature/command-script-catalog.md) — Command and generated script catalog (draft)
  - [developer-toolset.md](feature/developer-toolset.md) — Cc 共通開発ツールセット (draft)
  - [implementation-worktree.md](feature/implementation-worktree.md) — Ccが作成する作業worktreeとActio参照 (draft)
  - [inject-context-gating.md](feature/inject-context-gating.md) — 対象と会話の確証に応じた主要 Inject (implementation)
  - [major-inject-editor.md](feature/major-inject-editor.md) — 主要 Inject 文面の編集と適用 (implementation)
  - [orbis-vinculum-client.md](feature/orbis-vinculum-client.md) — Orbis Vinculum クライアント (draft)
  - [personal-ai-budget.md](feature/personal-ai-budget.md) — 個人の AI 予算 — 月間分と報酬分
  - [planning-adjustment.md](feature/planning-adjustment.md) — 企画調整課 — 体験の言葉で相談から調整まで進める (draft)
  - [revisor-risk-notice.md](feature/revisor-risk-notice.md) — Rv高スコアsystem通知
  - [shared-available-one-shot.md](feature/shared-available-one-shot.md) — Provider-neutral text generation (draft)
  - [sidecar-lifecycle-model-refresh.md](feature/sidecar-lifecycle-model-refresh.md) — 常駐サイドカー・待機判定・モデル更新 (draft)
  - [sprint-dialogues.md](feature/sprint-dialogues.md) — スプリントの人間判断と会話 (draft)
  - [task-branch-harness.md](feature/task-branch-harness.md) — 作業境界とブランチの二重確認 (draft)
  - [task-linked-followup.md](feature/task-linked-followup.md) — Actio タスクに紐づく作業案内と継続 (draft)
  - [taskflow-failure-visibility.md](feature/taskflow-failure-visibility.md) — Task workflow failure visibility
  - [webui-manuals-page.md](feature/webui-manuals-page.md) — マニュアルページ統合と WebUI ページ整理 (implemented)
- UX: [product.md](ux/product.md)
- 設計・契約: [model-catalog-port.md](interface/model-catalog-port.md) · [service-schema.md](interface/service-schema.md) · [runtime-boundaries.md](interface/runtime-boundaries.md)
- 不変条件 ID: `CC-PBUDGET-INV-01〜08`

#### `session-message-webui`

[domain.json](domains/session-message-webui.domain.json) — Renders the canonical session message stream for humans: the Discord-style work chat at /sessions/:id, the r…

- feature:
  - [session-message-webui-chat.md](feature/session-message-webui-chat.md) — Session message layer — later phases (WebUI chat, Lictor c… (partially-implemented)
  - [session-work-phases.md](feature/session-work-phases.md) — セッションの設計・開始確認・実装・調整 (draft)
  - [taskflow-failure-visibility.md](feature/taskflow-failure-visibility.md) — Task workflow failure visibility
  - [workplace-chat.md](feature/workplace-chat.md) — 職場チャットと相談の境界 (draft)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `runtime-orchestration`

[domain.json](domains/runtime-orchestration.domain.json) — Process composition and periodic runtime loops, including the internal cron scheduler.

- feature:
  - [actio-chat-transport.md](feature/actio-chat-transport.md) — Actioの通常チャンネル配送
  - [approval-inbox.md](feature/approval-inbox.md) — 承認インボックス — 人間宛て未回答事項の一元化 (planned)
  - [build-freshness.md](feature/build-freshness.md) — ビルド鮮度 (dist が src より古いまま稼働していないか)
  - [delegation-coordination.md](feature/delegation-coordination.md) — Delegation coordination API (implemented)
  - [delegation-spawn-target-validation.md](feature/delegation-spawn-target-validation.md) — 委託 spawn の着地検証とゾンビ回収
  - [delegation.md](feature/delegation.md) — Delegation Templates — 設計 (implemented)
  - [dependency-readiness.md](feature/dependency-readiness.md) — Cc 依存サービス診断コマンド (implemented)
  - [developer-toolset.md](feature/developer-toolset.md) — Cc 共通開発ツールセット (draft)
  - [discord-runtime-recovery.md](feature/discord-runtime-recovery.md) — Discord bot runtime recovery (implemented)
  - [domain-taxonomy.concordia.md](feature/domain-taxonomy.concordia.md) — Domain taxonomy: concordia (implemented)
  - [implementation-worktree.md](feature/implementation-worktree.md) — Ccが作成する作業worktreeとActio参照 (draft)
  - [inject-context-gating.md](feature/inject-context-gating.md) — 対象と会話の確証に応じた主要 Inject (implementation)
  - [module-manifest.md](feature/module-manifest.md) — モジュール台帳 — サービスモジュールの宣言的 manifest と ON/OFF 操作面 (planned)
  - [personal-ai-budget.md](feature/personal-ai-budget.md) — 個人の AI 予算 — 月間分と報酬分
  - [sidecar-lifecycle-model-refresh.md](feature/sidecar-lifecycle-model-refresh.md) — 常駐サイドカー・待機判定・モデル更新 (draft)
  - [sprint-dialogues.md](feature/sprint-dialogues.md) — スプリントの人間判断と会話 (draft)
  - [worker-leases.md](feature/worker-leases.md) — Fenced worker leases (implemented)
- 設計・契約: [nodejs-service-principles.md](architecture/nodejs-service-principles.md)
- 不変条件 ID: `CC-PBUDGET-INV-01〜08`

#### `persistence`

[domain.json](domains/persistence.domain.json) — Durable state and cross-cutting infrastructure: SQLite repositories for all entities plus shared config, sec…

- feature:
  - [github-issue-workflow.md](feature/github-issue-workflow.md) — GitHub Issue ワークフロー — Cc ラベル起点の対応 → 審査 → GitHub PR (implemented)
  - [major-inject-editor.md](feature/major-inject-editor.md) — 主要 Inject 文面の編集と適用 (implementation)
  - [personal-ai-budget.md](feature/personal-ai-budget.md) — 個人の AI 予算 — 月間分と報酬分
  - [task-branch-harness.md](feature/task-branch-harness.md) — 作業境界とブランチの二重確認 (draft)
  - [transcript-frame-async-persist.md](feature/transcript-frame-async-persist.md) — transcript-frame の非同期永続化 (implemented)
- 設計・契約: [schema.md](data/schema.md)
- 不変条件 ID: `CC-PBUDGET-INV-01〜08`

#### `configuration`

[domain.json](domains/configuration.domain.json) — 実行時設定の正本層。

- feature:
  - [personal-ai-budget.md](feature/personal-ai-budget.md) — 個人の AI 予算 — 月間分と報酬分
  - [settings-mcp.md](feature/settings-mcp.md) — Cc 設定の MCP 操作
- 設計・契約: [ddd.md](architecture/ddd.md)
- 不変条件 ID: `CC-PBUDGET-INV-01〜08`

#### `revisor-credentials`

[domain.json](domains/revisor-credentials.domain.json) — Revisor へアクセスするための資格情報 (workflow token) を Cc 側で保持・解決する層。

- feature:
  - [revisor-local-pr-submission.md](feature/revisor-local-pr-submission.md) — レビュー発火 — 作業ブランチの local PR 自動提出 (implemented)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `analysis-core`

[domain.json](domains/analysis-core.domain.json) — Core Anatomia analysis engine (session cache, parsing) together with skill frontmatter parsing/analysis and …

- feature:
  - [model-effort-review.md](feature/model-effort-review.md) — Genius model / effort review (implemented)
  - [skill-history.md](feature/skill-history.md) — Skill snapshot と履歴レビュー (implemented)
- 設計・契約: [ddd.md](architecture/ddd.md)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `analysis-report`

[domain.json](domains/analysis-report.domain.json) — アーキテクチャ解析の生成レポート面 (report/)。

- feature: なし (コード所属のみの domain)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `blackbox-decision`

[domain.json](domains/blackbox-decision.domain.json) — @ludiars/blackbox を使った学習型判定層。

- feature:
  - [actio-pr-continuation.md](feature/actio-pr-continuation.md) — Actio PR evidence and continuation
  - [human-response-confirmation.md](feature/human-response-confirmation.md) — 人間の応答がない確認ループを止める
  - [task-workflow.md](feature/task-workflow.md) — タスクワークフロー — 分解 → 委託実装 → 安定ブランチテスト → 自走 (planned)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `tooling`

[domain.json](domains/tooling.domain.json) — Automated test suites and shared test support that verify Concordia behavior.

- feature:
  - [command-script-catalog.md](feature/command-script-catalog.md) — Command and generated script catalog (draft)
  - [design-review-handoff.md](feature/design-review-handoff.md) — Resumable cross-service design review (draft)
  - [developer-toolset.md](feature/developer-toolset.md) — Cc 共通開発ツールセット (draft)
  - [domain-taxonomy.concordia.md](feature/domain-taxonomy.concordia.md) — Domain taxonomy: concordia (implemented)
  - [harness-reliability.md](feature/harness-reliability.md) — ハーネスの復旧と適用状況 (draft)
  - [migration-preflight.md](feature/migration-preflight.md) — ローカル migration 番号衝突の事前確認 (draft)
  - [qs-security-update.md](feature/qs-security-update.md) — qs の安全な固定版更新 (draft)
  - [script-creator.md](feature/script-creator.md) — Cc-owned script creator and shared command execution (draft)
  - [shared-available-one-shot.md](feature/shared-available-one-shot.md) — Provider-neutral text generation (draft)
  - [shared-one-shot.md](feature/shared-one-shot.md) — Shared one-shot launch boundary
  - [spec-index.md](feature/spec-index.md) — spec-index — spec frontmatter の機械生成索引 (implemented)
  - [task-branch-harness.md](feature/task-branch-harness.md) — 作業境界とブランチの二重確認 (draft)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `web-test-tooling`

[domain.json](domains/web-test-tooling.domain.json) — Automated component test suites and shared test support for the web/ frontend (vitest configuration, test se…

- feature:
  - [domain-taxonomy.concordia.md](feature/domain-taxonomy.concordia.md) — Domain taxonomy: concordia (implemented)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `transition-guard-example`

[domain.json](domains/transition-guard-example.domain.json) — builtin の transition-guard-example を無効化するオーバーライド。

- feature: なし (コード所属のみの domain)
- 設計・契約: [ddd.md](architecture/ddd.md)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

### ddd.md 未分類の domain (分類の採否は責任者が判断する)

#### `ai-note-publication`

[domain.json](domains/ai-note-publication.domain.json) — セッションで完成した AIノートの記事を、明示設定された Discord/Slack の投稿先へ届ける。

- feature:
  - [ai-note-publication.md](feature/ai-note-publication.md) — AIノートの記事完成通知
- UX: [product.md](ux/product.md)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `browser-bridge`

[domain.json](domains/browser-bridge.domain.json) — 人間が渡した Orbis sigillum のみをセッション固有の client id で操作する支援境界。

- feature:
  - [orbis-vinculum-client.md](feature/orbis-vinculum-client.md) — Orbis Vinculum クライアント (draft)
- UX: [product.md](ux/product.md)
- 設計・契約: [ddd.md](architecture/ddd.md)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `bug-bounty`

[domain.json](domains/bug-bounty.domain.json) — バグバウンティ: 仕組みの不具合の報告を Discord・セッション・Cocoiru から受け付け、AI が仕分け、採用した報告を Actio のタスクと hotfix の委託へつなぎ、反映を確認して報告者個人の A…

- feature:
  - [bug-bounty.md](feature/bug-bounty.md) — バグバウンティ — 報告の受付・AI の仕分け・hotfix・反映通知・個人への AI 予算
- UX: [product.md](ux/product.md)
- 不変条件 ID: `CC-BOUNTY-INV-01〜11`

#### `chores`

[domain.json](domains/chores.domain.json) — 雑務の受付・ワンショット実行・成果確認・継続への引渡し。

- feature:
  - [chores-forum-window.md](feature/chores-forum-window.md) — 雑務窓口と雑務課フォーラム (draft)
  - [chores.md](feature/chores.md) — Discord雑務とWeb専用ページ (draft)
  - [shared-one-shot.md](feature/shared-one-shot.md) — Shared one-shot launch boundary
- UX: [product.md](ux/product.md)
- 設計・契約: [ddd.md](architecture/ddd.md)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `cloud-execution`

[domain.json](domains/cloud-execution.domain.json) — 標準クラウドへの委託条件、送信意図・受付結果、成果物の整合性を扱う支援境界。

- feature:
  - [cloud-artifact-return.md](feature/cloud-artifact-return.md) — Artifact return revision — 2026-10-17 (draft)
  - [cloud-work-batch-kicker.md](feature/cloud-work-batch-kicker.md) — Codex Cloud batch kicker (parallel fan-out) (draft)
  - [cloud-work-drive-return.md](feature/cloud-work-drive-return.md) — Cloud work non-code outputs returned through Google Drive (draft)
  - [cloud-work-eligibility.md](feature/cloud-work-eligibility.md) — 標準クラウドへの委託条件 (draft)
  - [cloud-work-git-return.md](feature/cloud-work-git-return.md) — Gitを既定とするクラウド成果返送 (draft)
  - [cloud-work-runtime.md](feature/cloud-work-runtime.md) — Standard hosted cloud delegation runtime (draft)
  - [cloud-work-setup.md](feature/cloud-work-setup.md) — Standard cloud setup and recovery
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `cloud-observation`

[domain.json](domains/cloud-observation.domain.json) — クラウド作業の生存・工程・質問回答を観測する支援境界。

- feature:
  - [cloud-observation.md](feature/cloud-observation.md) — クラウド作業の観測と確認フォーラム (draft)
- UX: [product.md](ux/product.md)
- 設計・契約: [ddd.md](architecture/ddd.md)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `consultation`

[domain.json](domains/consultation.domain.json) — 技術相談のプライベート相談と公開: 閉じたチャンネルでの相談 (作成・閲覧者・招待/除外・終了時のロック)、共有面への不出力、相談から書き直した公開候補の本人承認と Tabula への投稿、Google Drive …

- feature:
  - [consultation-title-summary.md](feature/consultation-title-summary.md) — 公開相談の短いスレッド名 (draft)
  - [tech-consultation.md](feature/tech-consultation.md) — 技術相談 — 事前ヒアリング・プライベート相談・Tabula への公開
  - [workplace-chat.md](feature/workplace-chat.md) — 職場チャットと相談の境界 (draft)
- 不変条件 ID: `CC-CONSULT-INV-01〜12`

#### `consultation-turn-status`

[domain.json](domains/consultation-turn-status.domain.json) — Persistent consultation turn status and its presentation; provider execution and authorization remain outsid…

- feature:
  - [consultation-turn-status.md](feature/consultation-turn-status.md) — 応答の開始時刻と終了状態 (draft)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `daily-goal-run`

[domain.json](domains/daily-goal-run.domain.json) — デイリーゴール (WM-2)。

- feature:
  - [daily-goal-run.md](feature/daily-goal-run.md) — デイリーゴール — 専用チャンネルへの投稿でその日のゴールを登録し、1 時間ごとのワンショット判定で進み具合を見て、… (implemented)
  - [goal-and-go.md](feature/goal-and-go.md) — ゴールアンドゴー (goal-and-go 自走継続) (implemented)
  - [work-modes.md](feature/work-modes.md) — 作業の進め方 (work modes) — 方式の一覧と選び方 (draft)
- UX: [product.md](ux/product.md)
- 設計・契約: [ddd.md](architecture/ddd.md)
- 不変条件 ID: `CC-DG-INV-01〜12`, `CC-WM-INV-01〜04`

#### `dialogue-context`

[domain.json](domains/dialogue-context.domain.json) — 対話の前提データ: 部署のセッションが何をするかを定めるユースケース (フォーマット・作業モード・事前データ)、回答に対する人の訂正の蓄積、投稿ユーザーの依頼者メモを保持し、起動時のセッション入力へ組み立てる。

- feature:
  - [departments.md](feature/departments.md) — 部署 — 会社の下でセッショングループと処理を分ける (implemented)
  - [dialogue-context.md](feature/dialogue-context.md) — 対話の前提データ — ユースケース・人の訂正・依頼者メモ (implemented)
  - [planning-adjustment.md](feature/planning-adjustment.md) — 企画調整課 — 体験の言葉で相談から調整まで進める (draft)
  - [tech-consultation.md](feature/tech-consultation.md) — 技術相談 — 事前ヒアリング・プライベート相談・Tabula への公開
- 不変条件 ID: `CC-CONSULT-INV-01〜12`, `CC-DEPT-INV-01〜09`, `CC-DLG-INV-01〜06`

#### `discord-chat-relay`

[domain.json](domains/discord-chat-relay.domain.json) — Discord の指定チャンネルの人間の発言を既存の Discord ゲートウェイで拾い、設定に登録した転送先サービスへ中継トークン付きで転送し、サービスの返事を元の発言への reply として投稿する。

- feature:
  - [discord-chat-relay.md](feature/discord-chat-relay.md) — Discord の指定チャンネルの発言をサービスへ中継し、サービスの返事を同じ場所へ投稿する (implemented)
  - [line-webhook-relay.md](feature/line-webhook-relay.md) — LINE の共用チャネルを Cc が持ち、グループ + 言葉でサービスへ振り分けて中継し、返信を代行する (implemented)
  - [trust-boundaries.md](feature/trust-boundaries.md) — Concordia platform identity and trust boundaries (implemented)
- UX: [product.md](ux/product.md)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `harness-reliability`

[domain.json](domains/harness-reliability.domain.json) — Session checkpoint, hook observations and non-blocking official-guidance advisory.

- feature:
  - [harness-reliability.md](feature/harness-reliability.md) — ハーネスの復旧と適用状況 (draft)
  - [harness-status-card.md](feature/harness-status-card.md) — ハーネス状態カード (フック3) — 実装スペック (Codex 委託用)
  - [project-harness-policy.md](feature/project-harness-policy.md) — プロジェクト別DDD・契約適用と復旧可能なハーネス
  - [task-branch-harness.md](feature/task-branch-harness.md) — 作業境界とブランチの二重確認 (draft)
- UX: [product.md](ux/product.md)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `hook-transport`

[domain.json](domains/hook-transport.domain.json) — Cc command/MCP hook adapters preserving session and reliability semantics

- feature:
  - [codex-hook-console-free.md](feature/codex-hook-console-free.md) — Codex Cc hook transport without per-event shells (draft)
  - [windows-console-focus-investigation.md](feature/windows-console-focus-investigation.md) — Windowsの短命ウィンドウとフォーカス移動の調査 (investigating)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `internal-agent-model-policy`

[domain.json](domains/internal-agent-model-policy.domain.json) — Cc起動Claudeの内部Agentを既存タスクモデル選定へ接続する境界

- feature:
  - [internal-agent-model-policy.md](feature/internal-agent-model-policy.md) — Cc経由の内部Agentモデル選定 (draft)
- UX: [agent-delegation.md](ux/agent-delegation.md)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `line-webhook-relay`

[domain.json](domains/line-webhook-relay.domain.json) — LINE Messaging API の webhook を Cc の 1 か所で受け、チャネルシークレットで署名を検証し、共用チャネルのイベントをグループ + 呼びかけの言葉でサービスへ振り分けて中継トークン付きで…

- feature:
  - [line-webhook-relay.md](feature/line-webhook-relay.md) — LINE の共用チャネルを Cc が持ち、グループ + 言葉でサービスへ振り分けて中継し、返信を代行する (implemented)
  - [trust-boundaries.md](feature/trust-boundaries.md) — Concordia platform identity and trust boundaries (implemented)
- UX: [product.md](ux/product.md)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `management`

[domain.json](domains/management.domain.json) — CDGD マネジメント層 (dots サイドカー)。

- feature:
  - [cdgd-management.md](feature/cdgd-management.md) — CDGD マネジメント層 (dots サイドカー) (draft)
- UX: [product.md](ux/product.md)
- 設計・契約: [ddd.md](architecture/ddd.md)
- 不変条件 ID: `CC-MGMT-INV-01〜09`

#### `model-catalog`

[domain.json](domains/model-catalog.domain.json) — Supporting boundary owning adopted role snapshots, verified provider capabilities, daily refresh leases and …

- feature:
  - [sidecar-lifecycle-model-refresh.md](feature/sidecar-lifecycle-model-refresh.md) — 常駐サイドカー・待機判定・モデル更新 (draft)
- 設計・契約: [model-catalog-port.md](interface/model-catalog-port.md) · [ddd.md](architecture/ddd.md)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `personal-ai-budget`

[domain.json](domains/personal-ai-budget.domain.json) — 個人の AI 予算: 子会社の個人ごとに月間分と報酬分のトークン予算を持ち、月間分から先に消費する。

- feature:
  - [personal-ai-budget.md](feature/personal-ai-budget.md) — 個人の AI 予算 — 月間分と報酬分
  - [usage-budgets.md](feature/usage-budgets.md) — ユーザーとチームの月次予算
- UX: [product.md](ux/product.md)
- 不変条件 ID: `CC-BUDGET-INV-01〜08`, `CC-PBUDGET-INV-01〜08`

#### `plan-approval-notification`

[domain.json](domains/plan-approval-notification.domain.json) — Provider approval notifications with persistent pending questions and existing response authorization.

- feature:
  - [plan-approval-notification.md](feature/plan-approval-notification.md) — Provider plan approval notification (draft)
  - [question-option-codes.md](feature/question-option-codes.md) — 質問カードの選択肢コード
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `playtest-review-notify`

[domain.json](domains/playtest-review-notify.domain.json) — Ingenium の AI プレイテスト感想 (良い点・悪い点必須) を受け、run ごとに 1 回だけ、Cc の設定にある本社の Discord チャンネルと Slack webhook へ投稿する。

- feature:
  - [playtest-review-notify.md](feature/playtest-review-notify.md) — AI プレイテスト感想の投稿 (implemented)
- UX: [product.md](ux/product.md)
- 不変条件 ID: `CC-PLAYTEST-INV-01〜03`, `CC-PLAYTEST-INV-05〜06`

#### `project-created-notify`

[domain.json](domains/project-created-notify.domain.json) — 新規プロジェクトの登録を控え、最初に許可された push で本社チャンネルへ 1 回だけ通知する。

- feature:
  - [project-created-notify.md](feature/project-created-notify.md) — 新規プロジェクトの本社通知
  - [release-published-notify.md](feature/release-published-notify.md) — 公開リリース通知
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `service-deployed-notify`

[domain.json](domains/service-deployed-notify.domain.json) — Excubitor の service.deployed を受信し、Revisor 差分を任意に組み立て、プロジェクト単位の配送先へ安全に通知する。

- feature:
  - [checkout-published-deploy.md](feature/checkout-published-deploy.md) — checkout 前進後の deploy — checkout_published を受けて build と再起動へ繋ぐ (implemented)
  - [package-update-events.md](feature/package-update-events.md) — パッケージ更新のお知らせ (package-update-events)
  - [project-notification-preferences.md](feature/project-notification-preferences.md) — プロジェクト別デプロイ・リリース通知設定 (implemented)
  - [release-published-notify.md](feature/release-published-notify.md) — 公開リリース通知
  - [service-deployed-notify.md](feature/service-deployed-notify.md) — デプロイ反映通知
- UX: [product.md](ux/product.md)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `service-status`

[domain.json](domains/service-status.domain.json) — 子会社の拠点・サービス認可と、Excubitorの監視キャッシュから作る稼働状況の安全なチャット投影。

- feature:
  - [service-status-channel.md](feature/service-status-channel.md) — 子会社別のサービス稼働チャンネル (draft)
- UX: [product.md](ux/product.md)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `sprint-dialogues`

[domain.json](domains/sprint-dialogues.domain.json) — Durable sprint phase projections, genuine human decisions and recoverable Discord conversations.

- feature:
  - [shared-one-shot.md](feature/shared-one-shot.md) — Shared one-shot launch boundary
  - [sprint-dialogues.md](feature/sprint-dialogues.md) — スプリントの人間判断と会話 (draft)
- UX: [product.md](ux/product.md)
- 設計・契約: [ddd.md](architecture/ddd.md)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `task-fallback`

[domain.json](domains/task-fallback.domain.json) — Actio が使えない期間のタスク退避。

- feature:
  - [cc-task-fallback.md](feature/cc-task-fallback.md) — Cc 内蔵 Task と Actio 復旧同期 (implemented)
- 設計・契約: [ddd.md](architecture/ddd.md)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

#### `taskflow`

[domain.json](domains/taskflow.domain.json) — Task workflow v3.0: Actio content authority, scoped retrieval, stable task references and execution associat…

- feature:
  - [actio-acting-for.md](feature/actio-acting-for.md) — Actio への書き込みに指示者を付ける (SPEC-ACTIO-ACTING-FOR)
  - [actio-pr-continuation.md](feature/actio-pr-continuation.md) — Actio PR evidence and continuation
  - [implementation-worktree.md](feature/implementation-worktree.md) — Ccが作成する作業worktreeとActio参照 (draft)
  - [task-linked-followup.md](feature/task-linked-followup.md) — Actio タスクに紐づく作業案内と継続 (draft)
  - [task-workflow-v3.md](feature/task-workflow-v3.md) — Task workflow v3.0 — Actio authority
  - [taskflow-failure-visibility.md](feature/taskflow-failure-visibility.md) — Task workflow failure visibility
- UX: [product.md](ux/product.md)
- 不変条件 ID: `CC-TF-EXEC-INV-01〜04`

#### `web-access`

[domain.json](domains/web-access.domain.json) — Web UI の入口の信頼境界。

- feature:
  - [ex-viewer-base.md](feature/ex-viewer-base.md) — Ex Viewer のベースパス
  - [trust-boundaries.md](feature/trust-boundaries.md) — Concordia platform identity and trust boundaries (implemented)
  - [web-sso.md](feature/web-sso.md) — Web UI の公開ホストを Cloudflare ログイン 1 回で使う (Cernere 企業認証) (implemented)
- UX: [product.md](ux/product.md)
- 設計・契約: [ddd.md](architecture/ddd.md)
- 不変条件 ID: `CC-SSO-INV-01〜04`

#### `work-modes`

[domain.json](domains/work-modes.domain.json) — 作業の進め方 (方式) の一覧と選び方。

- feature:
  - [work-modes.md](feature/work-modes.md) — 作業の進め方 (work modes) — 方式の一覧と選び方 (draft)
- UX: [product.md](ux/product.md)
- 設計・契約: [ddd.md](architecture/ddd.md)
- 不変条件 ID: `CC-WM-INV-01〜04`

#### `work-submission`

[domain.json](domains/work-submission.domain.json) — Shared commit entry point and the single decision for how work reaches main (Revisor local PR / GitHub PR / …

- feature:
  - [work-submission.md](feature/work-submission.md) — 作業成果の提出 (commit / submit の共通入口)
- 不変条件 ID: — (feature 内に定義なし。横断の CC-INV-* は下表)

## 履歴扱いの feature

置き換え済み・廃止・適用外。現行の挙動の根拠にしない (経緯の参照用)。

| 文書 | 題名 | status |
|---|---|---|
| [director-patrol.md](feature/director-patrol.md) | Director 巡回 — 30 分ごとのチーム監視と実装セッションの自動起動 | superseded |
| [director-workflow.md](feature/director-workflow.md) | ディレクターワークフロー — 現場を回す人のワークロード定義とタスク整理 | superseded |
| [game-spec.md](feature/game-spec.md) | Omnipotens gameplay applicability and Concordia system spe… | not-applicable |
| [team-standup-and-review.md](feature/team-standup-and-review.md) | チーム朝礼と定例 — チームごとの定時報告と、人間同席のタスク棚卸し | superseded |
| [vibes-mode.md](feature/vibes-mode.md) | バイブスモード — 動作中のものをいじりながら確認する軽量レーン | retired |

## ドメイン外の資料

#### ux/

- [agent-delegation.md](ux/agent-delegation.md) — 作業委任 — 依頼を一度渡し、担当と成果を追跡する UX
- [meeting-respondent-handoff.md](ux/meeting-respondent-handoff.md) — Discord から本人の予定回答へ移る
- [product.md](ux/product.md) — Concordia — 全てのAIと人間が調和する空間を提供する
- [session-coordination.md](ux/session-coordination.md) — セッション協調 — 作業対象と途中経過を見失わない UX

#### architecture/

- [ddd.md](architecture/ddd.md) — Concordia の DDD 実装方針
- [nodejs-service-principles.md](architecture/nodejs-service-principles.md) — Concordia の Node.js 採用とサービス原則

#### interface/

- [model-catalog-port.md](interface/model-catalog-port.md) — Model catalog resolution contract
- [runtime-boundaries.md](interface/runtime-boundaries.md) — Omnipotens runtime boundary assessment
- [service-schema.md](interface/service-schema.md) — Concordia — Service Schema

#### data/

- [log-retention.md](data/log-retention.md) — ログ保持期間とアーカイブ
- [schema.md](data/schema.md) — データスキーマ

#### design/

- [lictor-cc-process-monitoring.md](design/lictor-cc-process-monitoring.md) — Lictor/Concordia セッションプロセス監視 — 設計資料
- [schema-migrations.md](design/schema-migrations.md) — スキーマ migration の規律

#### setup/

- [README.md](setup/README.md) — Concordia セットアップガイド (用途別)
- [anatomia-program-layers.md](setup/anatomia-program-layers.md) — Anatomia のプログラムドメイン層宣言 (`.anatomia/layers.json`)
- [augur-test-registry.md](setup/augur-test-registry.md) — Augur テスト台帳
- [codex-cli.md](setup/codex-cli.md) — Codex CLI worker
- [config-reference.md](setup/config-reference.md) — Concordia 設定キー正本 (config-reference)
- [core.md](setup/core.md) — Concordia 本体を起動するための設定 (core)
- [discord.md](setup/discord.md) — Discord bot を動かすための設定 (discord)
- [federation.md](setup/federation.md) — Concordia federation listener and site setup
- [harness-reliability.md](setup/harness-reliability.md) — ハーネスの導入と確認
- [harness-supervisor.md](setup/harness-supervisor.md) — 独立ハーネス監督スクリプトの配置
- [hooks-claude-code.md](setup/hooks-claude-code.md) — Claude Code hook integration
- [hooks-codex-cli.md](setup/hooks-codex-cli.md) — Codex CLI hook integration
- [log-injection.md](setup/log-injection.md) — Augur log injection を Concordia で使うための設定 (log-injection)
- [observability.md](setup/observability.md) — observability (旧 Excubitor) を有効にするための設定 (observability)
- [reproducible-build.md](setup/reproducible-build.md) — Reproduce the Omnipotens review
- [slack.md](setup/slack.md) — Slack bot を動かすための設定 (Hub + session channel)
- [spawn.md](setup/spawn.md) — セッション管制 (spawn) の設定 (spawn)
- [windows.md](setup/windows.md) — Windows で起動するための設定 (windows)

#### test/

- [review-test-plan.md](test/review-test-plan.md) — Omnipotens review verification plan
- [test-design.md](test/test-design.md) — テスト設計

#### faq/

- [actio-cc-task-project-sync.md](faq/actio-cc-task-project-sync.md) — Q: Actio と Concordia が同じタスクとプロジェクトを持つには、どう同期させるべきか
- [index.md](faq/index.md) — spec/faq 索引

#### plan/

中長期計画・調査・問題記録。ドメイン所属は任意で、現行仕様は feature 側が正本。

| 文書 | 題名 | status |
|---|---|---|
| [00-source-manifest.md](plan/00-source-manifest.md) | Omnipotens source manifest — Concordia | partial |
| [03-ludus-analysis.md](plan/03-ludus-analysis.md) | Ludus play analysis — applicability decision | not-applicable |
| [04-domain-model.md](plan/04-domain-model.md) | Concordia domain model baseline | complete |
| [05-anatomia-analysis.md](plan/05-anatomia-analysis.md) | Anatomia code and domain analysis | complete |
| [06-spec-domain-code-map.md](plan/06-spec-domain-code-map.md) | Specification, domain, and code map | partial |
| [07-spec-gaps.md](plan/07-spec-gaps.md) | Specification gaps and contradiction register | partial |
| [08-mechanics-economy.md](plan/08-mechanics-economy.md) | Mechanics and economy applicability / operational loop ana… | not-applicable |
| [09-aiformat-architecture-review.md](plan/09-aiformat-architecture-review.md) | AI Format and architecture-health review | complete |
| [10-ux-review.md](plan/10-ux-review.md) | Concordia UX review | partial |
| [11-vitia-marketability.md](plan/11-vitia-marketability.md) | Vitia marketability analysis | complete |
| [12-di-discussion-paper.md](plan/12-di-discussion-paper.md) | Di discussion paper — Concordia Omnipotens review | blocked |
| [2026-08-29-concordia-mac-console-spawn-and-site-template-overrides.md](plan/2026-08-29-concordia-mac-console-spawn-and-site-template-overrides.md) | Concordia: macOS コンソール spawn + delegation template の platf… | — |
| [2026-08-29-mac-spawn-impl-brief.md](plan/2026-08-29-mac-spawn-impl-brief.md) | 実装指示書: Mac Terminal.app spawn + delegation template platfo… | — |
| [2026-08-29-mac-spawn-impl-verification.md](plan/2026-08-29-mac-spawn-impl-verification.md) | Mac Terminal spawn + template overrides — 検証記録 | — |
| [2026-09-01-cc-event-loop-diet.md](plan/2026-09-01-cc-event-loop-diet.md) | Cc イベントループ軽量化 (2026-09-01) | — |
| [2026-09-01-subsidiary-team-apply-and-walk.md](plan/2026-09-01-subsidiary-team-apply-and-walk.md) | 子会社チーム適用 + チーム簡素化 + 散歩セッション + パートタイマー退勤 (2026-09-01) | — |
| [2026-09-04-externalize-partner-identifiers.md](plan/2026-09-04-externalize-partner-identifiers.md) | 取引先・未公開プロダクト識別子を設定へ外出しする | — |
| [2026-09-29-astra-with-sidecar-implementation.md](plan/2026-09-29-astra-with-sidecar-implementation.md) | Astra With Sidecar の実装 (Cc / actio:2261f19a) | — |
| [2026-10-11-cc-rv-data-growth-audit.md](plan/2026-10-11-cc-rv-data-growth-audit.md) | Cc/Rv response latency and data-growth audit | — |
| [2026-10-15-cf-cernere-sso.md](plan/2026-10-15-cf-cernere-sso.md) | Cc の Web UI を Cloudflare ログイン 1 回で使う (Cernere 企業認証への相乗り) | — |
| [2026-10-15-ludiars-design-review-fable.md](plan/2026-10-15-ludiars-design-review-fable.md) | LUDIARS 9-tool design review — Concordia | proposed |
| [2026-10-15-patrol-chat-implementation-design.md](plan/2026-10-15-patrol-chat-implementation-design.md) | 既存巡回チャットの拡張設計と実装引継ぎ | implemented |
| [2026-10-15-patrol-learning-design.md](plan/2026-10-15-patrol-learning-design.md) | 巡回チャット: ユーザーの発言からの断片と 1 日ごとの学習ルール (自動反映) | implemented |
| [2026-10-15-patrol-subsidiary-rules-design.md](plan/2026-10-15-patrol-subsidiary-rules-design.md) | 巡回チャット: ルールの子会社紐付け・子会社ごとの既定値・子会社サーバー管理者の編集 | implemented |
| [2026-10-16-cloud-work-delegation.md](plan/2026-10-16-cloud-work-delegation.md) | Cc cloud work delegation — design draft | — |
| [2026-10-16-ludiars-design-review-handoff.md](plan/2026-10-16-ludiars-design-review-handoff.md) | LUDIARS 9 ツール設計レビュー (Fable 支店) — 残作業引き継ぎ | planned |
| [2026-10-16-ludiars-design-review-handoff/notes-fable.md](plan/2026-10-16-ludiars-design-review-handoff/notes-fable.md) | Fable 自身が直接確認した事実 (2026-10-15) | — |
| [2026-10-16-ludiars-design-review-resume-review.md](plan/2026-10-16-ludiars-design-review-resume-review.md) | LUDIARS design review handoff — review and first implement… | proposed |
| [2026-10-16-title-context-preserve.md](plan/2026-10-16-title-context-preserve.md) | 文脈不明時の自動タイトル維持 | — |
| [2026-10-16-tokyo2070-cloud-trial.md](plan/2026-10-16-tokyo2070-cloud-trial.md) | Tokyo2070 hosted Blender modelling trial | — |
| [2026-10-22-inquiry-journal-boundaries.md](plan/2026-10-22-inquiry-journal-boundaries.md) | 学習日記と連合調査の境界修正 (draft) | — |
| [cc-stability-analysis.md](plan/cc-stability-analysis.md) | Cc セッション安定性解析 — 「よく落ちる」の原因分解と改修ポイント | — |
| [followup-no-progress-limit.md](plan/followup-no-progress-limit.md) | Bound automatic followups without progress | — |
| [harness-melpot-allowlist-design.md](plan/harness-melpot-allowlist-design.md) | 設計書: ハーネス main push 許可リスト (MELPOT 例外) | — |
| [multi-site-federation.md](plan/multi-site-federation.md) | マルチ拠点連合 (本社/子会社/担当サーバ) | draft |
| [p4-structural-hardening-2026-07-13.md](plan/p4-structural-hardening-2026-07-13.md) | P4 structural hardening — shared platform paths, web decom… | implemented |
| [problem_logs/2026-07-06-discord-compaction-alert-mojibake.md](plan/problem_logs/2026-07-06-discord-compaction-alert-mojibake.md) | Discord Compaction Alert Mojibake Regression | — |
| [problem_logs/2026-07-06-discord-end-session-unknown-interaction.md](plan/problem_logs/2026-07-06-discord-end-session-unknown-interaction.md) | Discord `/end-session` Unknown Interaction Regression | — |
| [problem_logs/2026-07-15-sync-taskkill-blocks-api.md](plan/problem_logs/2026-07-15-sync-taskkill-blocks-api.md) | API からの同期 taskkill が event loop を停止する | — |
| [problem_logs/2026-07-16-forum-codex-worker-session-registration.md](plan/problem_logs/2026-07-16-forum-codex-worker-session-registration.md) | Forum Codex spawn が session 登録前で止まる | — |
| [problem_logs/2026-07-16-headless-delegation-missing-transcript.md](plan/problem_logs/2026-07-16-headless-delegation-missing-transcript.md) | Headless Codex Delegation Does Not Persist Transcript | — |
| [problem_logs/2026-07-16-message-optimize-off-hides-working-content.md](plan/problem_logs/2026-07-16-message-optimize-off-hides-working-content.md) | Message Optimize OFF Still Hides Working Content | — |
| [problem_logs/2026-07-16-reaction-workflow-empty-allowlist.md](plan/problem_logs/2026-07-16-reaction-workflow-empty-allowlist.md) | Reaction Workflow Does Not Fire With an Empty User Allowlist | — |
| [problem_logs/2026-07-16-session-forum-spawn-no-template-tags.md](plan/problem_logs/2026-07-16-session-forum-spawn-no-template-tags.md) | Session forum spawn has no launch template tags | — |
| [problem_logs/2026-07-16-testworkflow-start-spawn-einval.md](plan/problem_logs/2026-07-16-testworkflow-start-spawn-einval.md) | TestWorkflow Start Fails With HTTP 409 on Windows | — |
| [problem_logs/2026-07-16-webui-technical-transcript-noise.md](plan/problem_logs/2026-07-16-webui-technical-transcript-noise.md) | WebUI の内部 transcript JSON が作業更新を埋もれさせる | — |
| [problem_logs/2026-07-18-delegation-forum-channel-emoji.md](plan/problem_logs/2026-07-18-delegation-forum-channel-emoji.md) | Delegation 起動セッションの Forum 名からテンプレート絵文字が消える | — |
| [problem_logs/2026-07-18-discord-forum-session-lifecycle.md](plan/problem_logs/2026-07-18-discord-forum-session-lifecycle.md) | Discord forum session lifecycle regression (2026-07-18) | — |
| [problem_logs/2026-07-18-discord-working-post-noise.md](plan/problem_logs/2026-07-18-discord-working-post-noise.md) | Discord Forum の「作業中」投稿がチャンネルを浮上させる | — |
| [problem_logs/2026-07-18-long-run-agent-cpu-and-transcript-storage.md](plan/problem_logs/2026-07-18-long-run-agent-cpu-and-transcript-storage.md) | Long-running Codex/Claude CPU and transcript storage inves… | — |
| [problem_logs/2026-07-18-lost-lictor-process-not-reaped.md](plan/problem_logs/2026-07-18-lost-lictor-process-not-reaped.md) | Lost session leaves a live Lictor process tree | — |
| [problem_logs/2026-07-18-session-end-reaper-race.md](plan/problem_logs/2026-07-18-session-end-reaper-race.md) | Session-end completion raced the ended-session reaper | — |
| [problem_logs/2026-07-19-session-workflow-three-strikes.md](plan/problem_logs/2026-07-19-session-workflow-three-strikes.md) | Session workflow recurring regressions (2026-07-19) | — |
| [problem_logs/2026-07-19-worktree-trust-config-missing.md](plan/problem_logs/2026-07-19-worktree-trust-config-missing.md) | Worktree startup trust configuration missing | — |
| [problem_logs/2026-07-23-delegation-windows-sandbox-helper.md](plan/problem_logs/2026-07-23-delegation-windows-sandbox-helper.md) | Delegation child sessions cannot initialize the Windows sa… | — |
| [problem_logs/2026-07-23-forum-starter-author-mismatch.md](plan/problem_logs/2026-07-23-forum-starter-author-mismatch.md) | Forum starter author mismatch breaks `session.started` | — |
| [problem_logs/2026-07-24-discord-fable-spawn-cwd.md](plan/problem_logs/2026-07-24-discord-fable-spawn-cwd.md) | Discord Fable spawn reports success without a session | — |
| [problem_logs/2026-07-24-session-end-answered-question-reported-pending.md](plan/problem_logs/2026-07-24-session-end-answered-question-reported-pending.md) | Session-end reports an answered question as pending | — |
| [problem_logs/2026-07-24-spawn-admin-token-regression.md](plan/problem_logs/2026-07-24-spawn-admin-token-regression.md) | Spawn session fails when admin authentication is unconfigu… | — |
| [problem_logs/2026-07-25-forum-auto-spawn-races-explicit-spawn.md](plan/problem_logs/2026-07-25-forum-auto-spawn-races-explicit-spawn.md) | Forum auto-spawn races an explicit Discord spawn | — |
| [problem_logs/2026-07-25-test-temp-cwd-spawn-race.md](plan/problem_logs/2026-07-25-test-temp-cwd-spawn-race.md) | Test temporary cwd spawn race | — |
| [problem_logs/2026-07-26-spawn-taskworkflow-discord-context.md](plan/problem_logs/2026-07-26-spawn-taskworkflow-discord-context.md) | Spawn / TaskWorkflow の Discord 文脈と Cc 判定が欠落する | — |
| [problem_logs/2026-08-01-test-workflow-controls-not-deployed.md](plan/problem_logs/2026-08-01-test-workflow-controls-not-deployed.md) | TestWorkflow の操作ボタンが表示されない | — |
| [problem_logs/2026-08-03-unstructured-ask-silently-dropped.md](plan/problem_logs/2026-08-03-unstructured-ask-silently-dropped.md) | 未構造化 ask マーカーが transcript relay で無言破棄される | — |
| [problem_logs/2026-08-04-pr-140-registered-test-failures.md](plan/problem_logs/2026-08-04-pr-140-registered-test-failures.md) | Revisor PR #140 の登録テストが2件失敗 | — |
| [problem_logs/2026-08-04-pr-140-stale-review-base.md](plan/problem_logs/2026-08-04-pr-140-stale-review-base.md) | Revisor PR #140 が古い base SHA で審査失敗 | — |
| [problem_logs/2026-08-06-manual-implementation-workflow-churn.md](plan/problem_logs/2026-08-06-manual-implementation-workflow-churn.md) | Manual Implementation Workflow Churn | — |
| [problem_logs/2026-08-06-test-forum-session-cwd-sandbox.md](plan/problem_logs/2026-08-06-test-forum-session-cwd-sandbox.md) | Test Forum session started inside the target repository | — |
| [problem_logs/2026-08-07-castra-root-session-binding.md](plan/problem_logs/2026-08-07-castra-root-session-binding.md) | Castra root overwrites the working-project session binding | — |
| [problem_logs/2026-08-07-test-forum-llm-revisor-authority.md](plan/problem_logs/2026-08-07-test-forum-llm-revisor-authority.md) | Test Forum session received authority over Revisor mutations | — |
| [problem_logs/2026-08-07-test-forum-session-token-and-reuse.md](plan/problem_logs/2026-08-07-test-forum-session-token-and-reuse.md) | Test Forum session lacks merge token and can spawn duplica… | — |
| [problem_logs/2026-08-08-claude-delegation-session-stall.md](plan/problem_logs/2026-08-08-claude-delegation-session-stall.md) | Claude Delegation Sessions Stall in Invisible Permission W… | — |
| [problem_logs/2026-08-08-concordia-runtime-build-regression.md](plan/problem_logs/2026-08-08-concordia-runtime-build-regression.md) | Concordia runtime build regression blocks restart | — |
| [problem_logs/2026-08-08-delegation-session-repo-binding-stuck-at-spawn-target.md](plan/problem_logs/2026-08-08-delegation-session-repo-binding-stuck-at-spawn-target.md) | Delegation-spawned session keeps its spawn-time repo_path/… | — |
| [problem_logs/2026-08-08-ended-session-process-residue.md](plan/problem_logs/2026-08-08-ended-session-process-residue.md) | 終了済みセッションの Lictor プロセスツリーが残留し続ける | — |
| [problem_logs/2026-08-08-local-pr-content-contract.md](plan/problem_logs/2026-08-08-local-pr-content-contract.md) | Local PR 内容がコミット件名だけになる | — |
| [problem_logs/2026-08-09-control-worker-crashed-stop-queue-stalled.md](plan/problem_logs/2026-08-09-control-worker-crashed-stop-queue-stalled.md) | control worker が crashed のまま停止キューが滞留し、セッション残留が再発している | — |
| [problem_logs/2026-08-09-delegation-initial-inject-stall.md](plan/problem_logs/2026-08-09-delegation-initial-inject-stall.md) | 実装委託が初回ターンで「承認待ち」の質問を返して停止する | — |
| [problem_logs/2026-08-12-revisor-381-clean-worktree-bootstrap.md](plan/problem_logs/2026-08-12-revisor-381-clean-worktree-bootstrap.md) | Revisor #381 clean-worktree dependency bootstrap failure | — |
| [problem_logs/2026-08-13-revisor-516-director-session-fixture.md](plan/problem_logs/2026-08-13-revisor-516-director-session-fixture.md) | Revisor #516 contract, plan-gate, and delegation review de… | — |
| [problem_logs/2026-08-13-revisor-532-merged-branch-reuse.md](plan/problem_logs/2026-08-13-revisor-532-merged-branch-reuse.md) | Revisor #532 reused a merged implementation branch | — |
| [problem_logs/2026-08-13-thinking-relay-stale-runtime.md](plan/problem_logs/2026-08-13-thinking-relay-stale-runtime.md) | Fable Discord tool-input relay was mistaken for thinking | — |
| [problem_logs/2026-08-15-compaction-clear-wipes-handoff.md](plan/problem_logs/2026-08-15-compaction-clear-wipes-handoff.md) | コンパクションの /clear が引き継ぎ資料ごとコンテキストを消す | — |
| [problem_logs/2026-08-17-stall-nudge-unintended-session-end.md](plan/problem_logs/2026-08-17-stall-nudge-unintended-session-end.md) | Stall nudge が待機中セッションを意図せず終了させる | — |
| [problem_logs/2026-08-18-revisor-discord-task-post-conflict.md](plan/problem_logs/2026-08-18-revisor-discord-task-post-conflict.md) | Revisor merge conflict for Discord task-body posting | — |
| [problem_logs/2026-08-22-revisor-local-pr-merge-leaves-shared-checkout-conflicted.md](plan/problem_logs/2026-08-22-revisor-local-pr-merge-leaves-shared-checkout-conflicted.md) | Revisor local PR merge failure leaves shared checkout conf… | — |
| [problem_logs/2026-08-23-concordia-event-loop-instability.md](plan/problem_logs/2026-08-23-concordia-event-loop-instability.md) | Concordia event-loop instability under delegation and rete… | — |
| [problem_logs/2026-08-23-discord-embed-dropped-before-session-inject.md](plan/problem_logs/2026-08-23-discord-embed-dropped-before-session-inject.md) | Discord embeds are dropped before session injection | — |
| [problem_logs/2026-08-23-node24-sqlite-native-addon.md](plan/problem_logs/2026-08-23-node24-sqlite-native-addon.md) | Node 24 SQLite native addon incompatibility | — |
| [problem_logs/2026-08-24-delegation-profile-drift-windows-codex-leak.md](plan/problem_logs/2026-08-24-delegation-profile-drift-windows-codex-leak.md) | Delegation Profile Drift and Windows Codex Leak Risk | — |
| [problem_logs/2026-08-31-ok-hand-reaction-triggered-handoff.md](plan/problem_logs/2026-08-31-ok-hand-reaction-triggered-handoff.md) | OK-hand Reaction Triggered an Unrequested Handoff | — |
| [problem_logs/2026-08-31-standalone-emoji-reaction-workflow-regression.md](plan/problem_logs/2026-08-31-standalone-emoji-reaction-workflow-regression.md) | Standalone Emoji No Longer Starts Reaction Workflow | — |
| [problem_logs/2026-08-31-subsidiary-discord-client-memory-amplification.md](plan/problem_logs/2026-08-31-subsidiary-discord-client-memory-amplification.md) | Subsidiary Discord Clients Amplified Memory Use | — |
| [problem_logs/2026-08-31-taskflow-workspace-root-task-collision.md](plan/problem_logs/2026-08-31-taskflow-workspace-root-task-collision.md) | Taskflow Workspace Root Collided with Child Repo Name | — |
| [problem_logs/2026-09-03-test-forum-reconcile-event-loop-stall.md](plan/problem_logs/2026-09-03-test-forum-reconcile-event-loop-stall.md) | Test Forum periodic reconcile stalls the event loop every … | — |
| [problem_logs/2026-09-04-revisor-1293-schema-contract-regression.md](plan/problem_logs/2026-09-04-revisor-1293-schema-contract-regression.md) | Revisor #1293 schema contract regression | — |
| [problem_logs/2026-09-05-delegated-claude-session-used-askuserquestion.md](plan/problem_logs/2026-09-05-delegated-claude-session-used-askuserquestion.md) | 委託先 Claude セッションが ask マーカーでなく AskUserQuestion を使った | — |
| [problem_logs/2026-09-05-delegation-question-relay-bypassed.md](plan/problem_logs/2026-09-05-delegation-question-relay-bypassed.md) | 委託子の質問が親と人間へ同時配信され、親のリレー回答が弾かれる | — |
| [problem_logs/2026-09-07-context-estimate-transcript-misattribution.md](plan/problem_logs/2026-09-07-context-estimate-transcript-misattribution.md) | コンテキスト占有の推定が別セッションの transcript を読んでいる | — |
| [problem_logs/2026-09-07-force-enter-relay-broken.md](plan/problem_logs/2026-09-07-force-enter-relay-broken.md) | 🙄 force-enter が届かない (出所ヘッダで CR が本文化 + ask 質問中の保留) | — |
| [problem_logs/2026-09-07-harness-service-recovery-dependency.md](plan/problem_logs/2026-09-07-harness-service-recovery-dependency.md) | Cc停止がCc復旧の編集・コマンドを止める | — |
| [problem_logs/2026-09-07-human-wait-confirmation-loop.md](plan/problem_logs/2026-09-07-human-wait-confirmation-loop.md) | 人間待ち中の確認・残作業分解ループ | — |
| [problem_logs/2026-09-07-workflow-lifecycle-notification-reliability.md](plan/problem_logs/2026-09-07-workflow-lifecycle-notification-reliability.md) | Issue 受付・ワーカー寿命・上限通知の運用レビュー5件 | implemented |
| [problem_logs/2026-09-08-attachment-wrong-channel.md](plan/problem_logs/2026-09-08-attachment-wrong-channel.md) | 資料添付の共通報告チャンネルへの誤配送 | — |
| [problem_logs/2026-09-08-continuation-resolved-answers.md](plan/problem_logs/2026-09-08-continuation-resolved-answers.md) | 継続 run が確定済みの判断を再質問する | — |
| [problem_logs/2026-09-08-kaizen-human-wait-partial-kind.md](plan/problem_logs/2026-09-08-kaizen-human-wait-partial-kind.md) | カイゼンの人間判断待ち報告にwait種別が欠けていた | — |
| [problem_logs/2026-09-08-taskflow-file-disclosure.md](plan/problem_logs/2026-09-08-taskflow-file-disclosure.md) | Task workflow content replication | — |
| [problem_logs/2026-09-09-closed-question-api-status.md](plan/problem_logs/2026-09-09-closed-question-api-status.md) | 閉鎖済み質問の回答 API が 400 を返す | — |
| [problem_logs/2026-09-09-glab-kd-project-registration.md](plan/problem_logs/2026-09-09-glab-kd-project-registration.md) | GLab の作業候補に KD が出ない | — |
| [problem_logs/2026-09-09-parttimer-work-report-completion.md](plan/problem_logs/2026-09-09-parttimer-work-report-completion.md) | パートタイマーが実作業・報告を終えず退勤する | — |
| [problem_logs/2026-09-09-subsidiary-astra-session-one-turn.md](plan/problem_logs/2026-09-09-subsidiary-astra-session-one-turn.md) | 子会社 Astra の対話セッションが初回回答で終了する | — |
| [problem_logs/2026-09-10-harness-request-and-recovery.md](plan/problem_logs/2026-09-10-harness-request-and-recovery.md) | 依頼の相談扱いへの後退とハーネスの未確認状態 | — |
| [problem_logs/2026-09-10-project-cwd-shared-context.md](plan/problem_logs/2026-09-10-project-cwd-shared-context.md) | Project cwd で共通スキル・メモリの入口が欠落 | — |
| [problem_logs/2026-09-11-ai-note-migration-freeze-missing.md](plan/problem_logs/2026-09-11-ai-note-migration-freeze-missing.md) | AIノート通知のマイグレーション 102 の凍結登録漏れ | — |
| [problem_logs/2026-09-11-push-workflow-misclassification.md](plan/problem_logs/2026-09-11-push-workflow-misclassification.md) | Revisor未登録とGitフック環境の誤判定 | — |
| [problem_logs/2026-09-12-initial-inject-design-stall.md](plan/problem_logs/2026-09-12-initial-inject-design-stall.md) | 初期 inject 後に設計・開始確認が進まない再発問題 | — |
| [problem_logs/2026-09-20-dead-peer-fetch-stalls-event-loop.md](plan/problem_logs/2026-09-20-dead-peer-fetch-stalls-event-loop.md) | 死んだ peer への fetch が event loop を止める (ゾンビ連鎖) | — |
| [problem_logs/2026-09-27-goal-loop-inject-contract-test.md](plan/problem_logs/2026-09-27-goal-loop-inject-contract-test.md) | Goal & Go 注入文の契約テスト回帰 | — |
| [problem_logs/2026-09-27-major-inject-review-regressions.md](plan/problem_logs/2026-09-27-major-inject-review-regressions.md) | 主要 Inject 編集の登録テスト回帰 | — |
| [problem_logs/2026-09-29-submitted-task-boundary-prompt-summary.md](plan/problem_logs/2026-09-29-submitted-task-boundary-prompt-summary.md) | 提出後の同一 PR 修正が submitted-task-boundary で止まる | — |
| [problem_logs/2026-10-04-consultation-title-echo.md](plan/problem_logs/2026-10-04-consultation-title-echo.md) | 公開相談名が長い入力のエコーになる | — |
| [problem_logs/2026-10-04-initial-title-task.md](plan/problem_logs/2026-10-04-initial-title-task.md) | 初回タイトル変更タスクの誤作動報告 | — |
| [problem_logs/2026-10-04-rv2265-git-fixtures.md](plan/problem_logs/2026-10-04-rv2265-git-fixtures.md) | #2265 再審査の Git fixture 失敗 | — |
| [problem_logs/2026-10-16-conflux-fixture-parent-hooks.md](plan/problem_logs/2026-10-16-conflux-fixture-parent-hooks.md) | Conflux fixture への親 Git hook 設定混入 | — |
| [problem_logs/2026-10-17-root-vitest-order-dependent-failures.md](plan/problem_logs/2026-10-17-root-vitest-order-dependent-failures.md) | ルート全体テストの実行順依存の失敗と fixture 不整合 | — |
| [problem_logs/2026-11-06-progress-marker-guidance-gap.md](plan/problem_logs/2026-11-06-progress-marker-guidance-gap.md) | 10分進捗要求とモニター書式の接続欠落 | — |
| [problems/cc-stability-problems.md](plan/problems/cc-stability-problems.md) | Cc セッション安定性 — 問題点一覧と対応状況 | — |
| [problems/stability-checklist.md](plan/problems/stability-checklist.md) | 長時間稼働サービスの安定化チェックリスト (汎用) | — |
| [process-isolation-v2.md](plan/process-isolation-v2.md) | プロセス分離 v2 — 影響半径 (blast radius) 最小化フォーカスでの再設計 | active |
| [refactor-3axis-architecture.md](plan/refactor-3axis-architecture.md) | 3軸分離リファクタリング — Cc 安定化と運用継続のためのアーキテクチャ再編 | planned |
| [refactor-3axis-architecture.session-log.md](plan/refactor-3axis-architecture.session-log.md) | 3軸分離リファクタリング計画 — 策定セッションログ | implemented |
| [tasks/README.md](plan/tasks/README.md) | 3軸分離リファクタリング — 実装タスク指示書 (索引・共通ルール) | planned |
| [tasks/phase-0.md](plan/tasks/phase-0.md) | Phase 0 タスク指示書 — 安全網 (依存境界 lint / テスト補充 / lag 計測) | planned |
| [tasks/phase-1.md](plan/tasks/phase-1.md) | Phase 1 タスク指示書 — 結合の機械的切断 (V1〜V14 の import レベル解消) | planned |
| [tasks/phase-2.md](plan/tasks/phase-2.md) | Phase 2 タスク指示書 — God Class 分割 (sessions / server / app / C… | planned |
| [tasks/phase-3.md](plan/tasks/phase-3.md) | Phase 3 タスク指示書 — プロセス分離 (cost-worker / chat-worker / event… | planned |
| [tasks/phase-4.md](plan/tasks/phase-4.md) | Phase 4 タスク指示書 — ディレクトリ再編 (任意・最後) | planned |
| [tasks/slack-session-channels.md](plan/tasks/slack-session-channels.md) | Slack session-per-channel 移行タスク | planned |

#### tasks/

作業要件と過去の実施記録 (現在のタスク状態の正本は Actio)。個別の索引は作らない。

## その他

- [feature/spec-index.md](feature/spec-index.md) — frontmatter から `spec-index.jsonl` を機械生成する (`npm run build:spec-index`、成果物は git 管理外)。
