---
type: feature
title: "participants — 人間入力者の identity レジストリ + クロスプラットフォーム・ミラー"
description: "Discord/Slack の複数プラットフォーム間で session 宛て発言を発言者付きで相互ミラーする。participants テーブルで platform handle と canonical 名を管理し、同名異 PF を同一人物として扱う identity レジストリを提供する。"
service: concordia
domain: chat-platforms
tags:
  - typescript
  - sqlite
  - discord
  - slack
  - relay
  - webhook
  - persona
  - lifecycle
status: implemented
updated: 2026-06-30
---


# participants — 人間入力者の identity レジストリ + クロスプラットフォーム・ミラー

## 目的
- **環境同期**: あるプラットフォーム(Slack)から session に入れた人間の入力を、相手
  プラットフォーム(Discord)の同 session channel/thread にも**発言者付きで転記**し、
  両PFの人が全員の入力を見られるようにする。
- **入力者を問わず実行 / 複数人の意見採用**: 誰の入力もそのまま session に注入され、
  ミラーで全員に可視化されるので、AI が両者の意見を踏まえて応答できる(集約/投票
  などの追加機構は持たない)。
- **発言者の名前解決**: 同名なら別PFでも同一人物として扱う(canonical 名)。

## 個人データ規約 (AIFormat §5)
本名/メール等の PII は持たない。`participants` は **platform handle + 表示名 +
canonical 名** のみで、loopback ローカル限定。Cernere ではなく Concordia ローカル
table に置く判断(2026-06-02、ユーザ決定)。

## データ ([`../../src/db/participants-repo.ts`](../../src/db/participants-repo.ts), schema v18)
`participants(platform, platform_user_id, display_name, canonical_name, first/last_seen)`。
`UNIQUE(platform, platform_user_id)`。`canonical_name = canonicalizeName(display_name)`
(前後空白除去 + 小文字化)で、別PFの同名を同一人物として `listByCanonical` で引ける。

## フロー
1. **ingress** (discord/ingress.ts, slack/bot.ts): session 宛て発言を
   `POST /v1/sessions/:id/inject` する際に `author_label`(表示名)を付ける。
   Slack は `users.info` で表示名を解決(キャッシュ)。
2. **inject endpoint** (api/sessions.ts): `source`(`discord:<uid>:…` / `slack:<uid>:…`)
   から platform+user を取り、`author_label` があれば `participants.upsert` で登録。
   `session.inject` event に `author_label` を載せて emit。
3. **mirror** (discord/bot.ts, slack/bot.ts): `session.inject` を購読し、**相手PF由来**
   (Discord は `slack:` のみ、Slack は `discord:` のみ)を自分の session channel/thread に
   `🔁 <PF> / <発言者>` 付きで転記。自PF由来は元発言が既出なので転記しない。
   転記は webhook/bot メッセージで ingress に拾われない(`author.bot`/bot_id で除外)→ ループ無し。
   制御 inject(`/enter` 等、source 例 `discord-enter`)は `^discord:`/`^slack:` に一致せず除外。

## meta チャットの同期
chitchat/consultation/報告 は既に各PF egress の「自source 以外を転記」で相互ミラー済。
本 PR は session 宛て inject の穴を埋めるもの。

## フォローアップ
- ぼやき チャット(独り言→たまにAI返信)の投稿を participants の persona 情報として
  収集する(別PR)。それ用に `persona_notes` 等の列を後続で追加予定。
- 別PF同名の衝突(別人が同名)時の手動リンク解除UIは未対応(ローカル運用では許容)。
