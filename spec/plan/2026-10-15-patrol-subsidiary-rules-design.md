---
type: plan
title: "巡回チャット: ルールの子会社紐付け・子会社ごとの既定値・子会社サーバー管理者の編集"
service: concordia
status: implemented
related:
  - spec/feature/patrol-chat.md
  - spec/feature/subsidiary-delegation.md
updated: 2026-10-15
---

# 巡回チャットの子会社単位設定

neco 2026-10-15: 「子会社単位でルール変えられるようにしようか」→ 3 点すべて採用
(ルールを子会社に紐付ける / 子会社ごとの既定値 / 子会社の人が自分で編集)。編集の入口は
「Discord ＋ サーバー管理者」(子会社 guild で Manage Guild 権限を持つ人が `/patrol` で編集)。
同日の運用指示: VOB (AI村) と GLab は 22:00〜09:30 に新規投稿しない、本社は時間帯なし。

## 1. 紐付け

- `rules.subsidiary_id` (NULL = 本社)。migration 139 `patrol-subsidiary-rules`。
- 子会社の巡回 rule は投稿先をその子会社 guild のチャンネルに限る:
  配送時の allowlist を rule の持ち主の guild だけにする (本社 rule は本社 guild だけ)。
  チャンネル ID はその場では guild を引けないので、保存時ではなく配送時に照合する (既存の allowlist と同じ所)。
- 子会社の巡回 rule は `scope_key=public` に限る (本社限定の素材を子会社へ出さない、CC-PATROL-05)。
- API: `GET /v1/rules?subsidiary_id=<id>|head_office=1`、`PUT /v1/rules` の `subsidiary_id`。
  存在しない / 無効な子会社 ID は 400。持ち主の付け替えは PATCH で可 (本社の操作面だけ)。
- Web `/rules`: 持ち主で絞り込み、編集画面で持ち主を選ぶ。

## 2. 子会社ごとの既定値

- `subsidiary_patrol_defaults(subsidiary_id PK, config JSON, updated_at, updated_by)`。
- config: `quiet_hours` / `root_limit_per_day` / `discord_channel_id` / `persona_hint` / `paused`。すべて任意。
- 実効値の解決 (純関数 `resolveEffectivePatrolConfig`):
  rule の action_config に**書かれている**値 → 持ち主の子会社の既定値 → 全体の既定値。
  - `quiet_hours`: 全体の既定は **null (時間帯なし)** に変える (本社は時間帯なし)。子会社は既定値で持つ。
    これまで未指定の rule は 22:00〜09:30 だったので、配備後に GLab / VOB の既定値へ 22:00〜09:30 を入れる。
  - `root_limit_per_day`: 全体 8。`discord_channel_id`: 全体 null。`persona_hint`: 全体なし。
  - `paused`: 子会社まるごとの停止。true の間は返信も含め新規の行動をしない (stopReason)。
- action_config の該当キーは「未指定 (undefined)」と「明示の null」を区別して保存する (zod の default を外す)。
- API: `GET/PUT /v1/subsidiaries/:id/patrol-defaults`。Web: 子会社の設定画面に既定値フォームと所属 rule の一覧。
- persona_hint は生成の指示に「名前の雰囲気: …」として渡す (判定には使わない、CC-PATROL-01)。

## 3. 子会社サーバー管理者の `/patrol`

- 子会社 guild にだけ登録する slash command (subsidiary-scope の許可集合に追加)。本社 guild には出さない
  (本社は Web の `/rules`)。
- 実行できるのはその guild で **Manage Guild** 権限を持つ人 (`default_member_permissions` と実行時の
  `memberPermissions.has(ManageGuild)` の二段)。本社の役職 (staff roster) とは切り離す。
- 対象はその Bot の子会社 (`deps.subsidiaryId`) の rule だけ。本社の専用窓口
  `/v1/subsidiaries/:id/patrol/*` が持ち主を照合する (rule の subsidiary_id と一致しなければ 404)。
- サブコマンド: `list` / `show` / `add` (トレンド巡回を 1 本、投稿先はコマンドを打ったチャンネルか指定チャンネル) /
  `set` (間隔・1日上限・時間帯・指示・投稿先) / `on` / `off` / `defaults` (表示) / `defaults-set`。
- 変更は rule の版 (revision) と rule_log に `discord:<user id>` として残す。応答は本人にだけ (ephemeral)。
- 子会社から変えられないもの: 素材元 (Tendentia 公開トレンド固定)、scope (public 固定)、持ち主、hard cap 超え。

## 4. 境界・不変条件

- CC-PATROL-05 (scope / 宛先): 子会社 rule は public 素材だけ、投稿先は持ち主の guild だけ。
- CC-PATROL-06 (停止): 子会社の `paused` と子会社自体の `enabled=false` は新規行動を止める。
- CC-PATROL-08 (版): `/patrol` の変更も revision を増やす。
