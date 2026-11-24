---
type: feature
title: "管制カード — 人間のアクション・判断をカードで管理し、捌きとリマインドを dots が担う (Cc v5)"
id: CC-CARDS
service: concordia
domain: control-cards
status: draft
related:
  - plan/2026-11-24-control-session-to-dots.md
  - feature/approval-inbox.md
  - feature/agent-instructions-bridge.md
  - feature/human-request-channel.md
  - feature/control-session.md
updated: 2026-11-24
---

# 管制カード (Cc v5)

> 所属ドメイン: [`control-cards`](../domains/control-cards.domain.json) (session-coordination の下位)。設計の正本は [Cc v5 計画](../plan/2026-11-24-control-session-to-dots.md)。Actio `5075ba3e-56f7-4f53-a732-af3fda910879`。

2026-11-24 neco 指示 (原文):「人間のアクション、人間の判断が必要なものをカードにして管制が管理するようにCcを改修するので、カードの捌きやリマインドを担当して欲しい。というのをdotsに伝えたのでCcを改修する」「カードやタスク状況、スプリント状況の管理はWebWIでやり、各セッションの細かい指示はDiscordでやる」。

## 価値・シナリオ

- 価値: 人間が「いま自分がやること・決めること」を 1 か所で見て片付けられる (UX-CC-W2 / W4)。
- シナリオ V5-S2: 人間が Web の `/control` でカード・Actio タスク・動いているセッション・スプリント状況を見る。dots が優先度と催促の時刻を決め、Cc が催促する。人間はカードの回答先 (既存の画面) で答え、出所が解決するとカードが閉じる。

## 業務用語と状態の所有者

| 用語 | 状態の正本 |
|---|---|
| カード | `control_cards`。出所の参照・捌き・催促の予定だけを持つ。**解決の正本は出所** |
| 捌き | `control_cards` の priority / assignee / remind_at / reminder_text / card_group と `triaged_by` (`dots:<instruction id>` / `human:<actor>`) |
| 催促 | `control_card_reminders` (送信記録) |

出所 (`source_kind`) と閉じる条件は [計画の表](../plan/2026-11-24-control-session-to-dots.md#カードの出所-既存の正本を変えない) のとおり。読み方は承認インボックスの read model (`src/inbox/read-model.ts`) と human-wait / CDGD の `waiting_human` / 進捗ボードの `unresponsive`。人間依頼 (`human-command`) だけは DB に記録が無いので AI の発言のマーカーからカードを作り、カードが正本 (人間の「済み」・人間依頼の OK ボタン・セッション終了で閉じる)。

## 不変条件

| ID | 内容 | 実装 |
|---|---|---|
| CC-V5-INV-02 | カードは出所の解決状態を書き換えない。回答・実行は既存の経路へ。カードから閉じられるのは人間依頼だけ (他は 409 `resolve_at_source`) | `card-domain.ts` / `service.ts` |
| CC-V5-INV-03 | 閉じるのは出所を読めて、未解決として現れなかったときだけ。読めなかった出所のカードは開いたまま | `card-sync-policy.ts` / `sources.ts` |
| CC-V5-INV-04 | dots の捌きは 5 列だけ。不明・閉じたカード・重複・範囲外の値は捨てる。最後に積んだ自分の指令の `done` だけを適用する | `card-triage-policy.ts` / `card-triage-dispatch.ts` |
| CC-V5-INV-05 | 催促は Cc が出す。同じカードは最短 30 分あけ、深夜帯 (`src/shared/quiet-hours.ts`) は出さない。メンションは構造化した担当者 1 人だけ、本文の mention は無効化 | `reminder-policy.ts` / `reminder-runner.ts` / `src/discord/desk.ts` |
| CC-V5-INV-06 | API と画面は loopback / 既存の Web SSO の範囲。dots には開けない | `src/api/control-cards.ts` |
| CC-V5-INV-07 | Web と Discord は同じ use case (`ControlCardsService`) を呼ぶ | `service.ts` |
| CC-V5-INV-08 | 破棄 (`discarded`) したカードは再び開かず、捌き・催促・既定の一覧に載せず、学習・判断カードの材料へ渡さない | `card-discard-policy.ts` / `card-sync.ts` / `repository.ts` |

## 破棄 (実装メモ 14)

2026-11-24 neco 指示 (原文)「すでに終了したセッション(現状管制が持つアクティブでないセッション)の判断カードは捨ててよい」「状態にdiscardを用意して学習にも使わないようにする。」。

- カードの状態は `open` / `closed` / `discarded`。破棄は `discarded_at` / `discard_reason` を残す。
- 判断カード (`human_judgment`) は持ち主のセッションが active (`sessions.status = 'active'`) のときだけ開いたまま置く。`session_id` があればそのセッション、無い `confirm-pending` は PR を出した Cc セッション (`confirm_runs` → `pr_records.author_session_id`) で判定する。理由は `session_inactive` (持ち主が active でない) / `session_unresolved` (持ち主を引けない)。
- 破棄しない: セッションに属さない判断 (`management-waiting-human` / `director-blocked` / `github-issue-approval`)、`session_id` の無いその他の判断カード、`human_action` (`human-command` / `session-unresponsive`)。持ち主の判定に要る読み取りが失敗した巡回も破棄しない。
- 破棄は出所を書き換えない (CC-V5-INV-02)。同期で作るときに持ち主が active でなければ最初から `discarded` で作り、出所が開いたままでも開き直さない。依頼窓口のスレッドへ知らせない。
- 学習: Cc には `control_cards` の内容を Genius など学習・判断カードの材料へ渡す経路が無い (2026-11-24 時点)。作るときは `discarded` を除く (CC-V5-INV-08)。

## 構成

- 巡回 (1 分、`session.control_session_enabled` が ON の間): 出所の同期 → dots への `card_triage` 指令 → 催促。
- 既定の捌き: 作成時に優先度 normal・催促は 24 時間後。催促した後も 24 時間後に次の予定。
- dots への指令 ([指令ブリッジ](agent-instructions-bridge.md)): 開いているカードの集合か捌きが変わったら、最短 10 分あけて 1 件だけ積む。前の指令が終わっていなければ積まない。params は優先度・古い順に最大 20 件、要旨 200 字、8000 バイト以内。回答 `detail.cards[]` = `{card_id, priority, assignee?, remind_at?, reminder_text?, group?}`。設定 `control_cards.dots_triage_enabled` (既定 ON)。
- 催促の届け先: 依頼窓口のスレッド (依頼から起動したセッションのカード)、無ければ管制チャンネル (メンションなし)。
- API: `GET /v1/control/cards?state=open|closed|all|discarded` (既定 open。`all` は開閉だけで、破棄は `discarded` でだけ読める。応答に `discarded_count`)、`PATCH /v1/control/cards/:id` (捌き 5 列と人間依頼の `done`)、`GET /v1/control/sprints` (スプリントの投影、読み取り専用で Actio へ書かない)。
- Web `/control`: カード (捌きの編集)・Actio タスク (既存 taskflow 一覧)・動いているセッション ([プランと進捗](control-session.md))・スプリント状況の 4 欄。カードの管理面は Discord に作らない。

## 復旧

- `control_cards` を空にしても次の巡回で開いているものが作り直される (捌きと催促の記録は失う)。
- `control_cards.dots_triage_enabled` を OFF で指令を出さない (既定の捌きで回る)。
- 管制を OFF (`session.control_session_enabled`) でカードの巡回は止まる。カードの表は残る。

## 実装の対応

`src/control-cards/` — `card-domain.ts` (用語)、`card-sync-policy.ts` / `card-discard-policy.ts` / `card-triage-policy.ts` / `reminder-policy.ts` (業務判断)、`card-sync.ts` / `human-command-cards.ts` / `card-triage-dispatch.ts` / `reminder-runner.ts` / `service.ts` (use case)、`repository.ts` / `sources.ts` / `card-owner-sessions.ts` (adapter)、`runtime.ts` (組み立て)。`src/api/control-cards.ts`、結線 `src/bootstrap/v5-desk-cards.ts`。

Web (`/control`):

- `web/src/pages/Control.tsx` — 4 欄の配置。
- `web/src/pages/control/CardsPanel.tsx` — カード欄と捌きの編集 (`CardEditor`、「破棄済み n 件」の切替、経過時間 `elapsed`・催促時刻の入力 `toLocalInput`)。人間依頼だけ「済み」を出す。
- `web/src/pages/control/SessionsPanel.tsx` と `SessionProgress.tsx` — 動いているセッションとプラン・進捗 ([control-session.md §13](control-session.md))。未計測・取得できないを出し分ける。
- `web/src/pages/control/TasksPanel.tsx` — Actio タスク (既存 taskflow 一覧を読むだけ)。
- `web/src/pages/control/SprintsPanel.tsx` — スプリント状況 (投影を読むだけ)。
- `web/src/pages/control/controlApi.ts` — 画面が呼ぶ API (`call`・`ApiError`・`controlApi`・過去の雑務の `choresApi`)。
- `web/src/pages/control/usePolling.ts` — 一定間隔の読み直し。読めなかった回は前の値を残してその欄だけ失敗を出す。

## テスト

`src/control-cards/policies.test.ts` (同期の開閉・読めない出所・dots 回答の範囲外・催促の間隔と深夜帯・破棄の判定)、`use-cases.test.ts`、`src/api/control-cards.test.ts`、`web/src/pages/Control.test.tsx`。
