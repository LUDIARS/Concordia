---
type: feature
title: "承認インボックス — 人間宛て未回答事項の一元化"
description: "ask_human 判断カード・inquiry・confirm 待ち・merge 承認待ちなど、散在する人間宛ての未回答事項を 1 つの WebUI inbox と朝夕ダイジェストに集約し、期限つきリマインドを行う read model 機能。"
service: concordia
domain: governance
tags:
  - inquiry
  - director
  - notification
  - webui
  - observability
status: planned
related:
  - feature/inquiry.md
  - feature/director.md
  - feature/director-goal-flow.md
  - feature/idle-nudge.md
  - feature/develop-confirm-flow.md
updated: 2026-08-11
---

# 承認インボックス — 人間宛て未回答事項の一元化

## 0. 課題

人間の判断待ちが複数の面に散る: ask カード (`discord_pending_questions`)、inquiry の
`ask_human` 着地、develop-confirm の確認待ち、merge 承認待ち、Director の blocked step。
どこに何件溜まっているか一覧できず、人間の待ち行列が業務のボトルネックになる。
Director ゴールフローが回るほど ask_human は増えるため、対で必要になる。

## 1. 原則

- **新しい正本を作らない**。inbox は既存テーブル群を束ねる read model であり、
  各項目の回答・解決は既存経路 (answer-question / confirm / director API) のまま行う。
- 集約対象と正本:

| 種別 | 正本 |
|---|---|
| ask カード | `discord_pending_questions` の未回答行（`inquiry_id` 無し） |
| inquiry ask_human | `session_events` の inquiry 監査行 + `inquiry_id` を持つ `discord_pending_questions` の未回答行 |
| Director blocked | `director_steps` (status = blocked) + 紐付く decision |
| confirm / 昇格承認待ち | `confirm_runs` の `pending` / `confirming` 行 |

- `ask_human` の inquiry は既存の質問カードへ `inquiry_id` を持たせ、その回答状態を
  解決状態の正本にする。inbox では監査行とカードを結合して **1 件だけ** 表示する。
  人間の別発言や nudge の disarm を回答・解決とみなさない。

## 2. API / WebUI

- `GET /v1/inbox` — 未回答事項の統合一覧。項目: 種別、要旨、宛先 (上長/任意)、発生時刻、
  経過時間、由来 session / case / PR へのリンク、回答経路。ソートは経過時間降順。
- WebUI `/inbox` ページ: 一覧 + 各項目から既存の回答 UI (質問カード / confirm / director case) へ遷移。
  ask カードは WebUI チャットの既存回答経路をそのまま使う。
- 既読・スヌーズはクライアント別に保持し (session_messages の client_id 既読と同じ方式)、
  正本の状態には影響しない。
  `inbox_item_state(client_id, item_key, read_at, snoozed_until)` は UI 状態専用とし、
  `item_key` は種別と正本の主キーから決定的に作る。回答や解決をこの表で表現しない。

## 3. ダイジェストとリマインド

- 朝夕 2 回、未回答件数と最古 3 件を Discord / Slack の meta channel へ 1 投稿する
  (件数 0 なら投稿しない)。
- 経過時間が閾値 (既定 24h) を超えた項目は idle-nudge 経路で上長メンション付き催促を出す。
  催促の重複抑止は項目単位の cooldown (既定 12h)。
- 深夜帯は既存 quiet-hours に従う。

## 4. 受け入れ基準

- [ ] 4 種別すべての未回答事項が `GET /v1/inbox` に出る。回答済み・解決済みは出ない。
- [ ] inquiry ask_human は関連する質問カードと重複せず 1 件として出て、`answer-question` 後は消える。
- [ ] inbox から各項目の既存回答経路へ遷移でき、inbox 自身は回答状態を書き換えない。
- [ ] 未回答 0 件の時間帯はダイジェストもリマインドも投稿しない。
- [ ] 同一項目への催促が cooldown 内に重複しない。
