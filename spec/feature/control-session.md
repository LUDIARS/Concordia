---
type: feature
title: "管制セッション — Cc の全セッションを 1 つの常駐セッションで見守り、進捗だけを上書きで持ち、止まった作業へ追加指示する"
description: "Cc の起動と同時に 1 つだけ動く管制セッション (singleton、落ちたら Cc が立て直す)。各セッションの状況はサイドチャンネル (stat-collect の現況報告とセッション行) から進捗ボードへ上書きで写し、管制の会話文脈には積まない。人間とは Discord の管制チャンネルで話し、状況確認は対話ごとに進捗ボードを読む短命の側セッションが答え、一括指示は Cc が対象を絞って既存の inject 経路で送る。自動確認でも作業状態が変わらないセッションには、管制セッションが追加指示を出す。既定 OFF で、1 設定で ON にする。"
service: concordia
domain: control-session
tags:
  - control-session
  - session-coordination
  - safety
status: implemented
related:
  - feature/autonomous-work-continuation.md
  - feature/goal-and-go.md
  - feature/human-response-confirmation.md
  - feature/daily-goal-run.md
  - ux/session-coordination.md
  - architecture/ddd.md
updated: 2026-11-16
---

# 管制セッション

> 所属ドメイン: [`control-session`](../domains/control-session.domain.json)

価値: UX-CC-SC-W2 (主)、UX-CC-SC-W3、UX-CC-W4。シナリオ SC-S2 / SC-S4、UX-CC-S5。
上位 UX は [セッション協調](../ux/session-coordination.md)、横断の不変条件は [ddd.md](../architecture/ddd.md) の CC-INV-03/04/06/08。

## 経緯

- 2026-11-16 neco 指示:「新しくメジャーに上げる前に Cc の管制セッションを作ろう」。
  1. 管制セッション = Cc の全セッションの出来事・イベントを統括するセッション。Cc 起動と同時に 1 つだけ動く。
  2. 各セッションの状況をすべて持つのではなく、サイドチャンネル (btw) で状況を追い、進捗だけを持つ (上書き)。
  3. ユーザーと対話できるチャンネル (Discord) を用意する。主用途は状況確認と、多数のセッションへの一括指示。
  4. ユーザーとの対話も全部サイドセッションで行う。
  5. 自動確認でそれぞれの動きが止まっているとき、管制セッションが追加指示をする。
- 人間の決定待ちのため、既定は OFF。`session.control_session_enabled` を 1 つ ON にすれば全部が動く。

## 構成要素と状態の所有者

| 要素 | 役割 | 状態の正本 |
|---|---|---|
| 管制セッション (本体) | 停止の要約を受けて追加指示を決める常駐 AI セッション。会話文脈には停止の要約だけが届く | セッション行 (Cc DB `sessions`)。保持者 (世代) は設定ストアの内部状態キー `control_session.holder` (人が編集する設定ではないので設定レジストリには載せない) |
| 管制の巡回 (supervisor) | 1 分ごとに singleton の起動・復旧、進捗ボードの更新、停止の検出と本体への要約送信 | なし (毎回 DB から決める) |
| 進捗ボード | セッションごとに最新 1 レコード (上書き)。履歴を持たない | Cc DB `control_progress_board` |
| 管制チャンネル | Discord の「管制」チャンネル。人間の状況確認と一括指示の入口 | Discord 設定 `control_channel_id` |
| 側セッション | 対話 1 回ごとに進捗ボードを読んで答える短命の 1 回限りの実行。会話を残さない | なし |

### 1. singleton の起動と復旧 (CC-CTL-INV-01)

- 設定が ON のとき、巡回は保持者 (spawn ID・世代・起動時刻) と、その spawn ID で登録された active なセッションを照合する。
  - 保持者が無い → 管制セッションを 1 つ起動し、保持者を記録する。
  - 保持者の spawn ID のセッションが active → 何もしない (Cc の再起動をまたいでも同じセッションを使い続ける)。
  - 起動後、猶予 (5 分) を過ぎても登録されない、または終了した → 新しい世代で立て直す。直前の起動から猶予が過ぎるまでは次を起動しない (起動の連打をしない)。
- 退役した世代のセッションが active のまま残っていたら、終了を促す 1 回の案内を送る (管制は常に 1 つ)。
- 管制セッションの作業場所は `<workspace>/.concordia-control/`。起動時に `CONTROL.md` (役割と使ってよい API・してはいけないこと) を置き、それを読ませて始める。
- 管制セッション自身は停止確認 (stall nudge)・Goal & Go・現況報告 (stat-collect) の対象から外す (CC-CTL-INV-02 の文脈を汚さない)。

### 2. 進捗ボード (CC-CTL-INV-02)

- 巡回ごとに active なセッションを 1 行ずつ上書きする。行の中身は: プロジェクト・branch・作業状態 (自動確認が記録した `cc_followup_progress` の state と「変化なし」回数)・現在のタスク (先頭だけ)・サイドチャンネルの最新の現況 (`/v1/stat` に届いた最新 1 件の要約)・最後の会話時刻。
- 終了したセッションの行は消す。行の履歴は持たない。管制セッションの会話文脈にもボードを積まない (必要なときに `GET /v1/control/board` で読む)。

### 3. 管制チャンネルと側セッション (CC-CTL-INV-03)

- 設定が ON の間、Discord に「管制」テキストチャンネルを用意する (カテゴリ外)。OFF の間は作らず、届いた発言には「管制は OFF」と返す。
- 投稿できるのはセッション操作を許可された人 (社員名簿) だけ。それ以外は理由を返して何もしない。
- 「一括:」「一括指示:」で始まる投稿は一括指示。`一括[Cc,At]: …` のようにプロジェクトコードで対象を絞れる (無ければ全 active)。Cc が対象を決めて §5 の経路で送り、送った数と送らなかった理由ごとの数を返信する。
- それ以外の投稿は状況確認。投稿ごとに側セッション (会話専用・ツールなしの 1 回限りの実行) が進捗ボードと質問だけを読んで答え、その返信を投稿へ返す。管制セッション本体の文脈には入れない。同時に動く側セッションは 2 つまでで、超えたら待ってもらう返信をする。

### 4. 停止したセッションへの追加指示 (CC-CTL-INV-04)

- 自動確認 ([autonomous-work-continuation](autonomous-work-continuation.md)) が作業状態の指紋を記録し、「変化なし」が 2 回以上続いたセッションを停止とみなす。
- 巡回は停止したセッションのうち §5 の送ってよい条件を満たすものだけを集め、まだ本体へ伝えていない指紋のものを 1 通の要約にして管制セッションへ送る (同じ指紋は 1 回だけ)。
- 管制セッションは追加指示が要ると判断したら `POST /v1/control/instructions` で送る。Cc は送り手が現在の管制セッションであることを確かめ、§5 の条件を送る直前にもう一度確かめてから届ける。

### 5. 指示の送り方 (CC-CTL-INV-05/06)

- 送ってよいのは active で、次のどれにも当たらないセッションだけ: 未回答の質問カード (照会できないときも送らない)・human-wait・人間の応答待ちの確認・transcript 末尾の ask マーカー・部署の自動確認 OFF・管制セッション自身。
- 届け方は既存の `session.inject` (source `auto:control`)。本文の先頭に来歴 (`[管制] 管制セッション第 N 世代から` / `[管制] <人間> の一括指示`) を付ける。ゲート・審査・許可範囲の判断は届け先のセッションの既存の規則に従い、管制は許可を足さない。
- 送ったことは管制チャンネルへ件数と対象だけを知らせる (本文は載せない)。届かなかった (WS 未接続) ものは送信済みにしない。

### 6. ON / OFF

- `session.control_session_enabled` (既定 OFF、WebUI の設定で切替、Cc 再起動不要)。
- OFF にすると、巡回は起動・要約・ボード更新をやめ、active な管制セッションへ終了を促す案内を 1 回送り、保持者を消す。API は `control_disabled` を返す。
- 戻し方: 設定を OFF にする。進捗ボードは表だけなので、消しても各セッションの状態には影響しない。

## 不変条件

| ID | 条件 |
|---|---|
| CC-CTL-INV-01 | 管制セッションは同時に 1 つだけ。保持者の世代と spawn ID で照合し、猶予内に重ねて起動しない |
| CC-CTL-INV-02 | 進捗ボードはセッションごとに最新 1 行の上書きだけで、履歴を持たない。管制セッションの文脈にボードや各セッションの会話を積まない |
| CC-CTL-INV-03 | 人間との対話は側セッションで答え、管制セッション本体の文脈に入れない。投稿は社員名簿で許可された人だけ受け付ける |
| CC-CTL-INV-04 | 停止の要約は同じ作業状態の指紋につき 1 回だけ本体へ送る |
| CC-CTL-INV-05 | 人間の判断待ち (質問カード・human-wait・応答待ちの確認・ask マーカー) と部署の自動確認 OFF のセッションには、一括指示も追加指示も送らない (照会できないときも送らない) |
| CC-CTL-INV-06 | 指示は既存の inject 経路で来歴付きで届け、届け先の審査ゲート・許可範囲を回避しない。追加指示は現在の管制セッションからだけ受け付ける |

## API

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/v1/control/status` | 設定・保持者・管制セッションの生死 |
| GET | `/v1/control/board` | 進捗ボード全件 |
| POST | `/v1/control/instructions` | `{from_session_id, targets: [session_id], text}`。管制セッションからの追加指示。結果は届けた / 送らなかった理由ごと |

すべて既存の loopback 認可の内側。OFF のときは 409 `control_disabled`。

## 実装の対応

- `src/control-session/` — 設定の読み出し、singleton の判定 (`singleton-policy.ts`) と保持者 (`holder-store.ts`)、進捗ボード (`board-repo.ts` / `board-projection.ts`)、送ってよい条件 (`instruction-eligibility.ts`)、届け方 (`instruction-dispatch.ts`)、停止の要約 (`stall-digest.ts`)、一括指示の解釈 (`bulk-command.ts`)、側セッション (`side-dialogue.ts`)、作業場所の準備 (`charter.ts`)、巡回 (`supervisor.ts`)、組み立て (`runtime.ts`)。
- `src/api/control-session.ts` — HTTP API。
- `src/discord/control-channel.ts` — 管制チャンネル。
- 既存部品の再利用: 停止の判定は `cc_followup_progress` (followup-progress.ts)、待ちの判定は pending-question-blocker / human-wait / human-response-confirmation / stalled-session-nudge の ask 判定、起動は `spawnSession` と pending spawn の相関 ID、側セッションは `runClaude` の会話専用実行。
