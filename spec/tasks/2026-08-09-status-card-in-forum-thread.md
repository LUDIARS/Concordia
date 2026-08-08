---
task: status-card-in-forum-thread
project: Concordia
kind: 実装
created: 2026-08-09
memory_links: []
---
# 状態カードをセッションの投稿に貼る / 委託スレッドへの導線

## 目的

2026-08-09 neco 指示。

1. 状態カード専用チャンネルは見られていない。forum 運用ではチャンネルを作らず、
   セッションの投稿 (forum thread) に貼る。
2. セッションから委託を起動したとき、起動できた子の投稿へのリンクを親の面に貼る
   (今はフォーラム一覧を目で探すしかない)。

## 完了条件

- forum 運用で状態カード用チャンネルを新規作成しない。カードはセッションの投稿へ貼られ、
  pin される。更新は同じメッセージの編集で行う。
- 投稿に貼る場合は bot 発言の purge をしない (会話を消さない)。
- カード撤去時に投稿ごと消さない (カードのメッセージだけ削除する)。
- 委託 run が起動できた時点で、親の面に子の投稿リンクが 1 回だけ貼られる。
  子の面がまだ無い場合は貼らず、次の status 変化で貼り直せる。

## スコープ (編集可ディレクトリ)

- `src/discord/session-status-card.ts`, `src/discord/delegation-thread-link.ts`, `src/discord/bot.ts`

## 補足

- チャンネル運用 (forumMode=false) の挙動は従来どおり。既存の status カテゴリの
  残骸は既存の `pruneStatusCategoryChannels` が掃除する。
