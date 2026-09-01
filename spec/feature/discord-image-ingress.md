---
type: feature
title: "Discord 添付・embed のセッション取り込み"
description: "Discord session channel の添付とrich embedを正規化し、表示テキストと安全に取得した画像を既存の session inject 経路へ渡す。"
service: concordia
domain: chat-platforms
tags:
  - typescript
  - discord
  - image
  - embed
  - injection
  - security
status: implemented
related:
  - ./discord-session-direct-inject.md
  - ./discord-lictor-relay.md
updated: 2026-08-23
---

# Discord 添付・embed のセッション取り込み

## 目的

Discord の session channel に添付された画像と `Message.embeds` の表示内容を、対象の
Codex / Claude セッションが確認できるようにする。本文、添付、embed のどれかだけの
投稿も扱う。

## 経路

1. `src/discord/ingress.ts` が session channel の画像添付と embed を検出する。
2. `src/discord/embed-ingress.ts` が embed の title / description / URL / author /
   provider / fields / footer / timestamp / video URL を表示文脈へ整形し、image / thumbnail の
   安全な Discord proxy URL を抽出する。
3. `src/discord/image-inbox.ts` が添付と embed 画像を Discord CDN / proxy から OS の一時 inbox へ取得する。
4. 元の本文、embed 文脈、保存済みローカルパス、画像を実際に確認する指示を 1 本の
   `/v1/sessions/:id/inject` にして既存経路へ渡す。
5. セッションはローカルパスを画像読取機能で開いてから依頼へ対応する。

Lictor の wire protocol や provider 固有の画像転送 API は増やさない。画像本体は
Concordia と同じ端末に保存され、Discord URL の有効期限後も処理中のセッションから読める。

## 安全境界

- 取得元は標準 HTTPS port の `cdn.discordapp.com` / `media.discordapp.net` のみとし、URL userinfo は拒否する。
- embed の外部原本 URL は直接取得せず、Discord が提供する安全な proxy URL を優先する。
- embed の表示文面は非信頼データとして区切り、境界を偽装できないよう構造文字をエスケープする。
- PNG / JPEG / GIF / WebP のみ、1 投稿 4 枚、1 枚 20 MiB を上限とする。
- SVG 等の未対応画像は本文付き投稿でも黙って無視せず、投稿全体を fail loud にする。
- redirect は許可せず、取得は 15 秒で打ち切る。レスポンス本文も streaming 中に容量を検査する。
- 一時ファイル名に session id / message id 以外の利用者入力を使わない。
- 一時 inbox はシンボリックリンクを拒否し、POSIX では実行ユーザー所有・0700 に限定する。
- inbox の 7 日より古いファイルは次回取り込み時に best-effort で削除する。
- 画像取得に失敗した場合は本文だけへ劣化せず、Discord に理由を返信して fail loud にする。
- 予期しない内部エラーは一般化して返信し、ローカルパス等の内部情報を Discord へ露出しない。

## 対象外

- meta channel、受付 channel、federation ingress への添付・embed入力。
- SVG、動画、PDF、一般ファイル。
- Discord 以外の URL を画像として代理取得すること。

## 完了条件

- 本文付き画像が、元本文とローカル画像パスを含む inject になる。
- 画像だけの投稿も捨てられず、画像を読む指示として inject される。
- embed だけの投稿も捨てられず、表示テキストと Discord proxy 画像が同じ inject に入る。
- 非 session channel の空本文添付は従来どおり無視する。
- URL、形式、件数、容量の境界違反はセッションへ注入しない。
