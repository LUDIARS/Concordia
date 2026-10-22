---
type: feature
title: "Slack platform（Hub + session-per-channel）"
description: "Concordia の Slack ChatPlatform。Hub channel と公開 Bot-only session channel、top-level ingress/egress、質問回答、Sessions/Cost Canvas、終了後 archive を提供する。"
service: concordia
domain: chat-platforms
tags:
  - slack
  - websocket
  - typescript
  - event-driven
  - relay
  - lifecycle
  - notification
status: implemented
related:
  - ../setup/slack.md
  - ./reaction-workflow.md
  - ../plan/tasks/slack-session-channels.md
updated: 2026-10-20
---

# Slack platform（Hub + session-per-channel）

## 目的と接続方式

Slack は Discord と対等な `ChatPlatform` adapter である。出力は in-process `eventBus`、
入力は Concordia HTTP API（`/v1/sessions/:id/inject`、`/v1/chat`、
`/v1/sessions/:id/answer-question`）へ接続する。

Concordia は loopback-only のため、Slack との接続には公開 Request URL を要しない
Socket Mode を使う。必須設定は Bot token、App token、Hub channel ID である。

## Hub channel

`CONCORDIA_SLACK_CHANNEL_ID` は Cc の Hub channel ID である。既存 channel を削除・rename
せず、次の機能を維持する。

- session 非紐付けの chitchat / consultation / 報告
- slash command と delegation modal
- Cost Canvas
- `Cc Sessions` Canvas

session の transcript 全文は Hub に relay しない。

## public Bot-only session channel

`session.started` または `ChatPlatform.ensureSessionSurface` で public channel を作る。

```text
cc-<題>
```

- `conversations.create({ is_private: false })` を Bot token で呼ぶ。
- `<題>` は Discord の channel 名の本体と同じ規則で作る (小文字化し、英数字・かな・漢字・hyphen 以外を hyphen にする)。
  80文字以内。題が無い・何も残らなければ `cc-<session-id先頭12文字>-session`。
- `name_taken` は `<題>` の後ろに session ID 12文字、次に session ID 由来の決定的 suffix を足して再試行する。
- 題が手動 / リアクションの rename (`title_renamed`、AI 自動提案 `title-suggestion` は除く) で変わったら、
  Discord の channel 名の追従と同じく `conversations.rename` で `cc-<新しい題>` へ改名する。
  `name_taken` は同じ候補順で進み、archive 済みの channel と失敗 (`missing_scope` 等、warn) は改名しない。
- Bot は作成者として在籍する。人間は「起動者の招待」の規則でだけ invite する。
- channel ID が routing の正本で、channel name は表示用である。
- purpose は完全な session ID、topic は短縮 ID / persona / provider / task / 状態を保持する。

## 起動者の招待

session channel を作ったら、その session を起動した人間を `conversations.invite` で招待する。

- 起動者は session の最も古い人間 inject (`discord:<uid>:…` / `slack:<uid>:…`) の入力者とする。
- Slack 起動はその Slack ユーザ、Discord 起動は Slack 設定の「メンバー対応表」
  (Discord user ID → Slack member ID) で引いた Slack ユーザを招待する。対応が無ければ招待しない。
- 契機は channel 作成直後 (`session.started` / 起動時 reconcile) と人間 inject。最初の inject が
  まだ永続化されていない場合は、その inject の入力者を起動者として使う。
- `already_in_channel` / `cant_invite_self` は招待済みとして扱う。それ以外の失敗は warn log のみで、
  channel 作成・中継は止めない。招待済みの記録はプロセス内だけに持ち、再起動後は再招待して
  `already_in_channel` で収束させる。
- 起動者以外 (後から指示した人) は招待しない。
- 対応表は `slack_config.member_map_enc` に暗号化保存し、`GET/PUT /v1/admin/slack/member-map`
  と設定画面で編集する。招待のたびに読むので、保存後の bot 再接続は不要。

常時招待メンバー (2026-10-22 kazumimitarai 指示「U9B7AE3SQ をチャンネルにメンバーとして招待」):

- 起動者とは別に、設定した Slack ユーザ ID 全員をすべての session channel に招待する。
  契機は起動者招待と同じ (session.started・人間 inject・Slack 起動時の active session 再照合)。
- 一覧は `slack_config.always_invite_enc` に暗号化保存し、`GET/PUT /v1/admin/slack/always-invite`
  (`{ user_ids: string[] }`、最大 50、`^[UW][A-Z0-9]{2,31}$`) で設定する。招待のたびに読むので再接続しない。
- 1 人ずつ `conversations.invite` し、1 人の失敗で他を止めない。`already_in_channel` は招待済み、
  その他の失敗は warn して次の契機で再試行する。

channel の最初のメッセージは session header card である。`header_ts` を保存し、persona、
task/title、終了、report の更新時に同じ message を `chat.update` する。active card は
「このチャンネルへ投稿すると session に送信」と案内し、ended card は `Done` と report
冒頭を表示する。session 終了時に channel rename はしない。

## 永続化

新規 routing の正本は `slack_session_channels` である。

| column | meaning |
|---|---|
| `session_id` | primary key |
| `channel_id` | unique Slack channel ID |
| `channel_name` | display / recovery 用 channel name |
| `header_ts` | header card message ts |
| `created_at` | epoch seconds |
| `archive_due_at` | archive 予定時刻、未予定は null |
| `archived_at` | archive 成功時刻、未完了は null |

同一 session の二重作成は in-flight lock と DB unique constraint で防ぐ。Slack API 成功後の
DB 永続化失敗は error log に出し、process 内に未永続 channel/header を保持して再永続化を
優先する。別 channel を無言で量産しない。

旧 `slack_session_threads` table は rollback / 履歴互換用に残すが、新規 routing では参照しない。
migration は `CREATE TABLE/INDEX IF NOT EXISTS` により冪等である。

## egress

session 紐付け出力は mapped session channel のトップレベルへ投稿し、`thread_ts` を渡さない。

- `chat.posted`
- `session.message` (canonical session message)
- `question.posted` の Block Kit
- working indicator
- session channel 内 reaction workflow の ack / result

出し分けは Discord と揃える。`session.message` の内容判定 (自面 ingress のこだま、質問・許可要求、思考、
成功した tool、端末入力・自動注入の user 発言、Cc 自身の inject の写し) は `src/platform/session-message-relay.ts`、
部署の出力方針 (途中の発言・Cc の指令の転記) は `src/platform/relay-output-filter.ts` を Discord と共用する。
Slack 固有は次の 3 点。

- user 発言は web 由来だけを流す。Discord から来た人間の指示は Slack へ転記しない。
- ターン中の状態表示 (`response_turn`) は working indicator が持つので流さない。
- 1 発言 1 投稿。`update` は配送記録 (`session_message_delivery`、platform=`slack`) から投稿を引いて `chat.update` する。

生の `transcript.frame` は Slack へ直接流さない (projector が作る `session.message` だけを使う)。
`chat.posted` も部署の出力方針に従い、途中の発言を止めた部署では本人の session 宛て (`system`) の
添付つき成果物だけを流す。

session 非紐付け chat は Hub のトップレベルへ投稿する。通常 relay は mention sanitizer を通し、
user mention / `@channel` / `@here` を生成しない。

### 添付ファイル

`chat.posted` の `metadata.attachment_paths` は、本文の postMessage の直後に同じ channel
(session channel、session 非紐付けなら Hub) のトップレベルへ `files.uploadV2` で 1 回にまとめて上げる。
ファイルの許可ルート・存在・容量の検査と読み込みは Discord と同じ `src/shared/attachment-files.ts` を通し、
口を増やさない。1 件 100 MiB を超えるもの、許可ルート外、不在、読めないものは warn に理由を残して飛ばす。
アップロードの失敗 (`missing_scope` 等) は warn に残し、本文の投稿は取り消さない。

## ingress と質問回答

Socket Mode の `message.channels` を channel ID で分類する。

- mapped session channel の top-level human message → 対応 session へ inject
- Hub の top-level human message → 従来どおり consultation chat
- 未知 channel → ignore
- Bot 自身、subtype 付き edit/system message → ignore
- `thread_ts` を持つ reply → ignore し、理由を info log に残す

session channel から inject した指示には、Discord と同じ契約で受領リアクション ✅
(`white_check_mark`) を付ける。inject が届いただけでは付けず、その session の `session.message`
または Slack 由来の `prompt` が動いた最初のタイミングで 1 回だけ付ける (保留は
`src/platform/inject-ack-tracker.ts` を Discord と共用し、インスタンスは分ける)。inject が失敗した指示には
付かない。付与の失敗 (`missing_scope` 等) は warn に残すだけで、指示の処理は止めない。

質問は session channel のトップレベルに出す。interaction は `body.channel.id` を
`slack_session_channels.channel_id` から逆引きして session を解決し、質問 message 自身の `ts`
を更新する。thread root / `thread_ts` には依存しない。

## archive lifecycle

`session.ended` は次の順で処理する。

1. header card を `Done` に更新
2. `archive_due_at` を `CONCORDIA_SLACK_ARCHIVE_DELAY_MIN` 後に設定
3. Sessions Canvas 更新を予約
4. 単一 archive sweeper が期限到来後に `conversations.archive` を実行
5. 成功後だけ `archived_at` を記録し、Sessions Canvas を更新

猶予の既定値は30分。有限の非負数のみ受理し、`0` は即時 archive、無効値は警告して30分へ
戻す。起動時にも期限超過行を sweep する。起動時には、session が終了済み・不明 (session 行が無い) なのに
予約も archive もされていない channel (停止中の終了などで session.ended を取りこぼしたもの) を同じ猶予で予約に回す。権限不足・一時障害では `archived_at` を書かず、
次回 sweep / restart で再試行する。`ChatPlatform.stop()` は archive timer、Canvas debounce、
event listener、Cost Canvas timer、Socket Mode 接続を解放する。

## Sessions Canvas

Hub に `Cc Sessions` Canvas を1つ作り、IDを `slack_config.sessions_canvas_id` に保存する。
保存 ID が失効した場合は削除して再作成する。更新 burst は debounce し、edit は直列化する。

表示 section:

- Active: DB status `active` かつ未質問待ち
- Waiting: DB の未回答 question がある `active`
- Recently completed: DB status `ended`（新しい順、最大20件）
- Failed / abandoned: DB status `lost` / `abandoned`

各行は channel link、short session ID、persona/provider、current task、updated time を表示する。
分類不能な状態は推測せず掲載しない。更新契機は session start/end、persona、task/title、
question posted/answered/resolved、report、archive success である。Canvas 更新のために Hub へ
chat message を連投しない。

## slash / delegation / reaction / Cost Canvas

既存の `/concordia`、`/co-*` slash、delegation modal、custom function は Hub で維持する。
reaction workflow は Hub と mapped session channel の両方を受け、session channel の結果は
top-level に出す。Cost Canvas は従来どおり Hub に1つ置き、`cost_canvas_id` を保存して edit する。

## 権限と fail-visible

Bot scope は少なくとも `channels:manage`、`channels:read`、`channels:history`、`chat:write`、
`reactions:read`、`canvases:write`、`commands`、添付のアップロードに `files:write`、指示の受領 ✅ に `reactions:write` を使う。`missing_scope` / `restricted_action` は
channel provisioning 時に明示的な error log を出す。旧 thread-per-session へ silently fallback
しない。

## 非対象

- private session channel
- 起動者以外の human member の自動招待
- User Group / shared sidebar section 管理
- per-user notification 設定変更
- Discord / chat-worker / delegation の一般 refactor

## テスト

repository、name collision、concurrent ensure、top-level egress、Hub/session ingress、thread ignore、
question channel mapping、session.message の出し分け (Discord と共通の判定・出力方針・update の編集)、
`cc-<題>` の命名と改名、添付のアップロード (まとめて 1 回・不在や容量超過を飛ばす・失敗で投稿を落とさない)、起動者招待 (対応表解決・招待済み/失敗の扱い)、archive retry/restart、Sessions Canvas classify/debounce/recreate、stop cleanup を
Vitest で検証する。live Slack 接続試験は stable checkout で Concordia testing claim と Excubitor
を使う場合に限る。
