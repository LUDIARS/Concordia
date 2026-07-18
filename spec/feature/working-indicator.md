---
type: feature
title: "「作業中」インジケータ"
description: "DiscordはForum状態タグ、Slackは末尾メッセージでセッションの作業状態を示す。"
service: concordia
domain: chat-platforms
tags:
  - typescript
  - discord
  - slack
  - state-machine
  - lifecycle
  - relay
status: implemented
updated: 2026-07-18
---

# 「作業中」インジケータ

## Discord

Discord Forumでは「🔄 作業中…」メッセージを投稿しない。指令またはtranscript進捗を
受けた時点でForum状態タグを `作業中` にし、`summary` または `final_answer` がWebhookへ
正常に投稿された後で `待機` に戻す。

- 投稿処理中は `作業中` を維持する。
- Webhook投稿が失敗した場合は `作業中` を維持する。
- Codexのcommentaryは完了扱いにしない。
- Claude互換providerのphaseなしassistant frameは最終回答として扱う。
- `session.lost` / `session.ended` はsession状態側のタグ処理を優先する。
- per-sessionのタグ更新を直列化し、短い応答でも付与・解除の順序を保証する。

実装: `src/discord/channel-work-state.ts`、`src/discord/egress.ts`、
`src/platform/transcript-completion.ts`

## Slack

Slackは従来どおり `WorkingIndicator` を使い、mapped public session channelの末尾へ
「🔄 作業中…」を投稿する。進捗で削除・再投稿し、無進捗タイムアウトまたは
`session.lost` / `session.ended` で削除する。

実装: `src/platform/working-indicator.ts`、`src/slack/bot.ts`
