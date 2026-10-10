---
type: feature
title: "「作業中」インジケータ"
description: "DiscordはForum状態タグと1通の「作業中…」、Slackは末尾メッセージでセッションの作業状態を示す。"
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
updated: 2026-10-10
---

# 「作業中」インジケータ

## Discord

指令またはtranscript進捗を受けた時点でForum状態タグを `作業中` にし、`summary` または `final_answer` がWebhookへ
正常に投稿された後で `待機` に戻す。

- 投稿処理中は `作業中` を維持する。
- Webhook投稿が失敗した場合は `作業中` を維持する。
- Codexのcommentaryは完了扱いにしない。
- Claude互換providerのphaseなしassistant frameは最終回答として扱う。
- `session.lost` / `session.ended` はsession状態側のタグ処理を優先する。
- per-sessionのタグ更新を直列化し、短い応答でも付与・解除の順序を保証する。

状態ノード (`onSessionWorkState`) への反映は `src/discord/bot.ts` の
`sessionWorkStateApply` を唯一の入口とする (state-machine 規約の apply 入口)。

### 「🔄 作業中…」の投稿 (2026-10-10 復活)

neco 指示 (2026-10-10): 作業中か停止中かがわかりづらくなった。作業中の時に「作業中…」を
投稿するやつをエンジニア課以外で復活させる。総務などは途中の発言と Cc の指令を出さないため、
状態タグだけでは動いているのか止まっているのかが見えなかった。

- 状態タグを `作業中` にした時に、スレッドへ「🔄 **作業中…**」を 1 通だけ webhook で投稿する。
- `待機` に戻した時・`session.lost`・`session.ended` で削除する (既に無ければ何もしない)。
- 進捗ごとの削除・再投稿はしない。2026-07-18 にそれで Forum 投稿が一覧の上へ浮き続けた
  (`spec/plan/problem_logs/2026-07-18-discord-working-post-noise.md`)。1 作業につき投稿 1 回・削除 1 回に留める。
- 出すかどうかは部署の出力方針 `working_post` (departments.md §9.4) で決める。全体設定は無く、
  inherit は出す。エンジニア課 (全ログを出す部署) は `off` にする。
- 投稿・削除は per-session で直列化し、失敗はログに残して次の作業で出し直す。

実装: `src/discord/channel-work-state.ts`、`src/discord/working-post.ts`、`src/discord/egress.ts`、
`src/discord/bot.ts`、`src/discord/webhook-pool.ts` (`deleteForSession`)、`src/platform/transcript-completion.ts`

## Slack

Slackは従来どおり `WorkingIndicator` を使い、mapped public session channelの末尾へ
「🔄 作業中…」を投稿する。進捗で削除・再投稿し、無進捗タイムアウトまたは
`session.lost` / `session.ended` で削除する。

実装: `src/platform/working-indicator.ts`、`src/slack/bot.ts`
