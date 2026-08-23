---
type: feature
title: "Discord 添付画像のセッション取り込み"
description: "Discord session channel の画像を安全な一時 inbox へ保存し、画像読取可能なローカルパスを既存の session inject 経路へ渡す。"
service: concordia
domain: chat-platforms
tags:
  - typescript
  - discord
  - image
  - injection
  - security
status: implemented
related:
  - ./discord-session-direct-inject.md
  - ./discord-lictor-relay.md
updated: 2026-08-23
---

# Discord 添付画像のセッション取り込み

## 目的

Discord の session channel に添付された画像を、対象の Codex / Claude セッションが
ローカルの画像読取機能で確認できるようにする。本文付き投稿と画像だけの投稿を扱う。

## 経路

1. `src/discord/ingress.ts` が session channel の画像添付を検出する。
2. `src/discord/image-inbox.ts` が Discord CDN から OS の一時 inbox へ取得する。
3. 元の本文、保存済みローカルパス、画像を実際に確認する指示を 1 本の
   `/v1/sessions/:id/inject` にして既存経路へ渡す。
4. セッションはローカルパスを画像読取機能で開いてから依頼へ対応する。

Lictor の wire protocol や provider 固有の画像転送 API は増やさない。画像本体は
Concordia と同じ端末に保存され、Discord URL の有効期限後も処理中のセッションから読める。

## 安全境界

- 取得元は HTTPS の `cdn.discordapp.com` / `media.discordapp.net` のみ。
- PNG / JPEG / GIF / WebP のみ、1 投稿 4 枚、1 枚 20 MiB を上限とする。
- redirect は許可せず、取得は 15 秒で打ち切る。レスポンス本文も streaming 中に容量を検査する。
- 一時ファイル名に session id / message id 以外の利用者入力を使わない。
- inbox と画像ファイルは、同じ OS ユーザ以外へ公開しない権限で作成する。
- inbox の 7 日より古いファイルは次回取り込み時に best-effort で削除する。
- 画像取得に失敗した場合は本文だけへ劣化せず、内部パスを含まない案内を Discord に返信して fail loud にする。

## 対象外

- meta channel、受付 channel、federation ingress への画像入力。
- SVG、動画、PDF、一般ファイル。
- Discord 以外の URL を画像として代理取得すること。

## 完了条件

- 本文付き画像が、元本文とローカル画像パスを含む inject になる。
- 画像だけの投稿も捨てられず、画像を読む指示として inject される。
- 非 session channel の空本文添付は従来どおり無視する。
- URL、形式、件数、容量の境界違反はセッションへ注入しない。
