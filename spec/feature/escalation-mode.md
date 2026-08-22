---
title: "Escalation mode"
status: implemented
service: concordia
domain: session-coordination
updated: 2026-08-21
---

# エスカレーションモード

インフラ (Concordia / Revisor / Excubitor 等) が停止し、通常のワークフローでは復旧そのものが
進められない状況で、**まず動作状況を確保する**ためのセッション状態。

通常ワークフローは「並行セッションが互いを壊さないこと」を守るために task 登録・worktree 分離・
Revisor 経由の PR を要求する。 これらはすべて Cc と Revisor が生きていることを前提にしている。
前提が崩れているときに同じ規律を課すと、復旧作業だけが永久に始められない。

エスカレーションモードは、その前提が崩れた期間だけ規律を外し、**外したことを記録に残して
後追いでレビューできるようにする**。 Revisor の CLI 限定バイパスマージ
(`Revisor spec/feature/daemonless-cli.md`) と対になる仕組みで、片方だけでは詰まりは解けない。

## 1. モードの宣言と記録

Cc が応答できる場合は、開始を `POST /v1/sessions/:id/escalation { reason }`、解除を
`DELETE /v1/sessions/:id/escalation { note }` で行う。 `reason` は必須。状態は
`sessions.escalation_mode` (bool) と `escalation_events` (session_id / actor / reason /
started_at / ended_at / note) に保持する。

**Cc が応答できず、この API を呼べない場合**は、復旧を始めるセッションが provider の永続
session transcript に `ESCALATION` と明記した record（理由・開始時刻・対象リポジトリ）を残して
宣言する。この宣言は API の成功を待つ必要がない。Cc は復帰後、この record を取り込んで同じ内容の
`escalation_event` を作成し、監査記録を補完する。解除も同じ transcript に終了時刻と note を追記し、
Cc 復帰後に確定する。

`reason` を必須にするのは、後追いレビューの対象を記録だけから特定できるようにするため。
理由の無いエスカレーションは、事後には通常作業と区別が付かない。

Cc が稼働中は、セッション文脈パケットと harness status card がエスカレーション中であることを
明示する。停止中は前項の transcript record がこの表示の代わりとなり、復帰後に status card へ反映する。
モードは記録であって権限昇格ではない — 誰がいつ何のために規律を外したかが常に読める。

## 2. 他セッションへの作業停止 claim

Cc が稼働中にエスカレーションを開始した場合、Cc は **他のエスカレーションセッションを除く全
active セッション**へ作業停止 claim を送る。Cc 停止中は claim を配送できないため、開始セッションは
transcript record にこの未配送状態を明記し、Cc 復帰後に配送または不要化を判断する。

- 配送は既存の pending task 経路に載せ、優先扱いにする (キュー末尾に積まない)。
- 受け取ったセッションは、現在の編集を中断し、commit 済み / 未 commit の状態を報告して停止する。
  破棄はしない — 停止であって巻き戻しではない。
- エスカレーションセッション同士は止め合わない。 復旧に複数人 (複数セッション) が要る場合に
  互いを止めると、この仕組み自体が詰まりの原因になる。
- 解除時、停止 claim は取り下げられ、停止していたセッションは再開可能になる。Cc 停止中に
  未配送だった claim を、復帰後に遅延配送して停止させてはならない。

停止させる理由は衝突回避そのもの: エスカレーション中のセッションは worktree を使わず本ブランチを
直接触るため、同じリポを触る他セッションが居ると相互に壊す。

## 3. エスカレーション中のワークフロー

該当セッションに注入されるワークフローパケットは、通常版を次のように差し替える。

| 通常 | エスカレーション中 |
|------|--------------------|
| task 登録 / task_update 必須 | 不要 (ハーネスの作業登録を無視する) |
| task 専用 worktree で編集 | **本ブランチを直接操作してよい** |
| Revisor local PR 経由でのみ main へ | Revisor CLI のバイパスマージを使ってよい |
| PR 作成で停止 | 動作確保まで進めてよい |

外れないものは外れない:

- GitHub への直 push / GitHub PR 作成・マージの禁止は維持する。
- 実 finding を出したセキュリティスキャンは、バイパスマージでも止まる。
- 破壊的操作 (他セッションの変更の破棄、共有 checkout の巻き戻し) は依然として行わない。

これらはインフラの生死と無関係な規律であり、止まっているから外してよい理由が無い。

## 4. 解除と後追い

解除時にエスカレーション期間の記録が確定する。 期間中に入った変更のうち、Revisor の
`bypassMerge` が付いたものは `revisor pr bypassed` で列挙でき、`revisor pr bypass-reviewed`
で後追いレビュー済みにする。 Cc 側は escalation_event に紐づけて「この停止期間に何が入ったか」
を 1 つの記録として読めるようにする。

## 実装状況

実装済み (2026-08-21, Memoria #836)。

| 節 | 実装 |
|----|------|
| §1 宣言と記録 | `POST /v1/sessions/:id/escalation { reason }` / `DELETE /v1/sessions/:id/escalation { note }` / `GET /v1/sessions/:id/escalation` (`src/api/sessions/escalation.ts`)。 `reason` が空なら 400。 状態は `sessions.escalation_mode`、 監査は `escalation_events` (`src/db/escalation-repo.ts`, migration 70)。 |
| §1 transcript 宣言 | `src/control/escalation-transcript-record.ts` (パーサ) + `src/control/escalation-transcript-intake.ts` (取り込み)。 sweeper の周期 (`src/sweeper.ts` `ingestEscalationRecords`) が復帰後に走らせ、 同じ内容の `escalation_event` を冪等に作る。 |
| §1 表示 | セッション文脈パケットの `escalation` (`src/control/collaboration-context.ts`) と状態カード (`src/harness/escalation-status.ts` → `src/discord/session-status-card.ts`)。 |
| §2 停止 claim | `src/control/escalation-mode.ts`。 kind `work-stop-claim` を `pending_tasks` へ `priority` 付きで積む (`pull` は priority 降順)。 解除時に当該 kind の claim を未配送・配送済みとも破棄する — 配送済みを残すと retry 周期 (`requeueForRetry`) が未配送へ戻し、 終わった停止が再配送される。 報告する `withdrawn_claims` は未配送分のみ。 |
| §3 ワークフロー差し替え | `src/control/escalation-workflow.ts`。 外すもの (`ESCALATION_RELAXED_RULES`) と外さないもの (`ESCALATION_RETAINED_RULES`) を 1 箇所に持つ。 |

### transcript record の書式

Cc が応答できないときの宣言 (§1) は次の行を transcript に残す。 `at` を省くと frame の時刻を使う。

```
ESCALATION start reason="Cc が落ちていて task 登録も PR も通らない" at=2026-08-21T09:00:00Z repo=E:/Document/Ars/Concordia
ESCALATION end at=2026-08-21T10:30:00Z note="Cc 復帰、 バイパスマージ 2 件"
```

理由の無い `start` は取り込まない — API と同じ理由で、 理由の無い記録は後追いレビューの対象を特定できない。
