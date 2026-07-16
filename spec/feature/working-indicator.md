---
type: feature
title: "「作業中」インジケータ"
description: "セッションが指令を受けて transcript が動いている間、Discord / Slack session channel の最後のメッセージとして「作業中」を表示し、進捗時に削除・再投稿する platform 非依存状態機械。"
service: concordia
domain: chat-platforms
tags:
  - typescript
  - discord
  - slack
  - state-machine
  - lifecycle
  - relay
  - webhook
  - notification
status: implemented
updated: 2026-07-16
---


# 「作業中」インジケータ

## 目的
セッションが指令を受けて transcript が動いている間、チャンネルの**最後のメッセージ**
として「🔄 作業中…」を出し続け、進捗があったら消す。これで「まだ動いているのか／
止まった・入力待ちなのか」をリモート（Discord / Slack）で一目で判別できる。

ユーザ指示:
> 指令を受け付けて transcript が動いている間は「作業中」というメッセージを必ず
> 最後に投稿し、進捗があった際は消すようにする。

## 振る舞い（[`../../src/platform/working-indicator.ts`](../../src/platform/working-indicator.ts)）
`WorkingIndicator` は per-session の状態機械。post/remove はプラットフォーム依存の
コールバック注入（Discord/Slack 双方から使える）。

- **進捗（`noteProgress`）**: transcript.frame / セッション chat / prompt 受領で発火。
  既存の「作業中」を**即削除**（最下部でなくなったため）→ `repostDelayMs`（既定 1.5s）
  落ち着いてから最下部に再投稿。連続進捗中は削除のみ繰り返しタイマをリセットするので
  フリッカらず、ストリーミングが一段落した時に最下部へ出る。
- **idle 除去**: `idleMs`（既定 60s、Discord は `CONCORDIA_DISCORD_WORKING_IDLE_SEC`、
  Slack は `CONCORDIA_SLACK_WORKING_IDLE_SEC`）無進捗で除去。
  = 作業が止まった／入力待ち。
- **clear**: `session.ended` / `session.lost` で即除去。
- per-session に操作を promise チェーンで直列化し、delete/post の取り違えを防ぐ。

## Discord 配線（[`../../src/discord/bot.ts`](../../src/discord/bot.ts)）
- 投稿は **webhook ではなく通常 bot メッセージ**（`channel.send`）。`message.delete` で
  確実に消せるため。session channel が active のときのみ。
- `routeEvent` で: `transcript.frame` / `chat.posted(session)` / `session.event(prompt)`
  → `noteProgress`、`session.ended` / `session.lost` → `clear`。
- bot 自身の投稿なので ingress は `author.bot` で無視し、自己ループしない。

## Slack 配線（[`../../src/slack/bot.ts`](../../src/slack/bot.ts)）

- mapped public session channel のトップレベルへ `chat.postMessage` し、`thread_ts` は渡さない。
- `chat.delete` は `slack_session_channels` の channel ID を使う。
- `transcript.frame` / session `chat.posted` / prompt で `noteProgress`、ended / lost で `clear`。
- Bot 自身の message は ingress classifier が無視する。

## 既知の制約 / フォローアップ

- 「作業中」テキストは固定。将来 current_task を併記する余地あり。
