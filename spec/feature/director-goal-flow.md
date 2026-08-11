---
type: feature
title: "Director ゴールフロー — 案件単位のゴール定義・工程自動進行・可視化"
description: "人間が案件単位のゴールを定義すると、Director が分解→委託→レビュー→確認を自動進行し、WebUI/Discord/Slack で進捗を可視化する。director.md の「後続工程」とされた自動進行を確定する spec。"
service: concordia
domain: governance
tags:
  - director
  - goal-and-go
  - delegation
  - taskflow
  - state-machine
  - webui
status: planned
related:
  - feature/director.md
  - feature/goal-and-go.md
  - feature/inquiry.md
  - feature/task-workflow.md
  - feature/develop-confirm-flow.md
updated: 2026-08-11
---

# Director ゴールフロー — 案件単位のゴール定義・工程自動進行・可視化

## 0. 位置づけ

[director.md](director.md) は case/step/decision の正本と Genius 判断分離を実装済みで、
「委託の自動起動、step の自動進行、Discord UI」を後続工程とした。本 spec がその後続工程の
正本である。原則は director.md §0 を維持する: Director は判断する LLM ではなく、
判断は Genius、権限・スコープ・破壊的操作は人間、Cc は決定論的な進行管理だけを行う。

既存の `/co-goal` / goal API はセッション単位のゴールである。本 spec の goal は
**case 単位** (セッションをまたぐ案件) であり、両者は別物として共存する。

## 1. ゴール定義入口

- Discord: `/co-goal-case title:<タイトル> goal:<ゴール記述> [project:<code>] [budget_runs:<n>]`
- Slack: `/co-goal-case` → modal (同項目)
- WebUI: `/director` ページの New Goal フォーム
- API: `POST /v1/director/cases { title, goal, project?, budget?: { max_runs, max_tokens }, deadline? }`

goal 記述には達成条件 (受け入れ基準) を含めることを入力 UI で促す。入力は
`director_cases` へ起案され、最初の `decompose` step が自動作成される。

## 2. 工程自動進行 (director engine)

`src/director/engine.ts` (新設)。イベント駆動の決定的ステートマシンで、LLM を内包しない。

| 遷移契機 | 動作 |
|---|---|
| case 起案 | `decompose` step を active 化し、taskflow の分解プロンプトを delegation で起動 (task md 生成) |
| 分解完了 (task md 生成) | task ごとに `delegate` step を起案し、delegation template で spawn。runtime option `goal_and_go: true` を既定 ON |
| delegation run 完了 | `review` step へ。Revisor local PR 提出は既存経路 (session 側) を用い、Director は run/PR id の参照だけ持つ |
| develop への実装 PR マージ通知 | `confirm` step (develop-confirm-flow を流用) |
| confirm 完了 | 残 task が無ければ `complete` |

- 判断が必要な遷移は `director.md` の Decision Request と既存 `GeniusClient` を使い、
  結果を `director_decisions` に監査保存する。`proceed` なら無停止で進み、`ask_human` で
  step を blocked にして判断カードを 1 件作る。`self_judge` は担当セッションへ明示する。
  `POST /v1/inquiry` はセッション単位の API なので、case 単位の engine からは呼ばない。
  `authority` / `scope` は director.md どおり Genius 不在でも ask_human に固定する。
- merge、テスト開始、サービス制御、push、破壊的操作は engine の action 対象外
  (director.md の境界を維持)。

### 暴走防止

- case 単位の委託回数上限: 既定 10 run (`budget.max_runs` で上書き)。
- case 単位の累計トークン予算 (任意)。cost-observability の session 集計を case へ畳んで判定する。
- 上限到達時は起動せず `director_case_stopped` イベントと停止理由を保存し、人間入力で予算をリセットする。
- blocked が 24 時間続いた case は idle-nudge 経路で上長へ催促する。
- セッション単位の goal-and-go 予算 (回数/時間) はそのまま併用し、緩和しない。

## 3. 可視化

- WebUI `/director`: case 一覧 (工程別 kanban: 依頼/分解/実装/レビュー/確認/完了 + blocked)。
  case 詳細 = step タイムライン、紐付く delegation run / local PR / director_decisions の判断履歴、
  case 畳み込みコスト。
- Discord: case ごとに forum thread + 状態カード (session-status-card のパターンを流用し、
  step 遷移時に同一 embed を更新する)。
- Slack: Hub に `Cc Director` Canvas を 1 枚置き、Sessions Canvas と同じ debounce / 直列化で更新する。

いずれも read model であり、taskflow / delegation / PR の正本を複製しない (director.md §3)。

## 4. 受け入れ基準

- [ ] ゴール 1 件の投入から、人間の追加入力なしで分解→委託→local PR 提出まで進む
      (inquiry が proceed を返し続ける場合)。
- [ ] authority / scope に該当する判断は必ず ask_human で blocked になる。
- [ ] case の run 回数・トークン予算を超えて委託を起動しない。
- [ ] WebUI `/director` で「どの工程で、何に blocked か」が 1 画面で分かる。
- [ ] Discord の case thread の状態カードが step 遷移で更新される。
- [ ] engine は LLM を呼ばない (判断は inquiry/Genius、生成は委託先セッション)。
