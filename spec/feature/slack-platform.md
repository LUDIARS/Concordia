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
updated: 2026-07-16
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
cc-run-<session-id先頭8文字>-<slug>
```

- `conversations.create({ is_private: false })` を Bot token で呼ぶ。
- channel 名は lowercase ASCII / digit / hyphen のみ、80文字以内。
- slug は current task/title 由来、空なら `session`。
- `name_taken` は session ID 12文字、次に session ID 由来の決定的 suffix で再試行する。
- Bot は作成者として在籍する。人間を自動 invite しない。
- channel ID が routing の正本で、channel name は表示用である。
- purpose は完全な session ID、topic は短縮 ID / persona / provider / task / 状態を保持する。

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
- relay 対象の `transcript.frame`
- `question.posted` の Block Kit
- working indicator
- session channel 内 reaction workflow の ack / result
- Discord 由来 human inject の mirror

session 非紐付け chat は Hub のトップレベルへ投稿する。通常 relay は mention sanitizer を通し、
user mention / `@channel` / `@here` を生成しない。

## ingress と質問回答

Socket Mode の `message.channels` を channel ID で分類する。

- mapped session channel の top-level human message → 対応 session へ inject
- Hub の top-level human message → 従来どおり consultation chat
- 未知 channel → ignore
- Bot 自身、subtype 付き edit/system message → ignore
- `thread_ts` を持つ reply → ignore し、理由を info log に残す

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
戻す。起動時にも期限超過行を sweep する。権限不足・一時障害では `archived_at` を書かず、
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
`reactions:read`、`canvases:write`、`commands` を使う。`missing_scope` / `restricted_action` は
channel provisioning 時に明示的な error log を出す。旧 thread-per-session へ silently fallback
しない。

## 非対象

- private session channel
- human member の自動招待
- User Group / shared sidebar section 管理
- per-user notification 設定変更
- Discord / chat-worker / delegation の一般 refactor

## テスト

repository、name collision、concurrent ensure、top-level egress、Hub/session ingress、thread ignore、
question channel mapping、archive retry/restart、Sessions Canvas classify/debounce/recreate、stop cleanup を
Vitest で検証する。live Slack 接続試験は stable checkout で Concordia testing claim と Excubitor
を使う場合に限る。
