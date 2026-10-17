---
type: feature
title: "AI プレイテスト感想の投稿"
description: "Ingenium の ingenium playtest が渡す AI プレイテスト感想 (良い点・悪い点必須) を、Cc が設定した本社の Discord チャンネルと Slack webhook へ投稿する。送り手は宛先も秘密も持たない。"
service: concordia
domain:
  - playtest-review-notify
status: implemented
updated: 2026-10-15
tags:
  - notification
  - ingenium
  - playtest
---

# AI プレイテスト感想の投稿

2026-10-15 neco 指示: 「AIオートプレイヤーが画面と説明書を見て操作しながら、UX/操作感/ゲームの感想を投稿していく仕組みを Ingenium に用意。
Voluptas を通して匿名性の情報として扱う。プレイ時の感想・挙動・反省を Discord や Slack に投稿する。良い点と悪い点をちゃんと投稿する。」
続けて「Cc接続し、cc経由して投稿するようにしましょう」「プレイノートはローカルで貯めつつDiscordの投稿と設定でTabulaに投稿できる」。Actio `actio:c9464253-a17d-486a-8613-e8d12bf3a888`。

価値: UX-CC-W11 / シナリオ UX-CC-S12 ([プロダクト UX](../ux/product.md)、draft)。
送り手の仕様は Ingenium `spec/feature/playtest-review.md`、匿名保存は Voluptas `spec/feature/ai-playtest-reviews.md`。

## 口

`POST /v1/events/playtest-review` (`src/api/playtest-review.ts`)。認証はデプロイ・リリース通知と同じ:
`x-excubitor-token` が Discord 設定の `excubitor_dispatch_token` と一致すること。未設定なら loopback 運用 (`host` が 127.0.0.1 / localhost) のときだけ通す。

本文 (strict。決めていない項目があれば 400):

| 項目 | 内容 |
|---|---|
| `runId` / `gameId` / `gameTitle` / `persona` / `outcome` | 1〜200 文字 |
| `screen` | `image` / `text` |
| `ticks` / `turns` | 0 以上の整数 |
| `summary` | 1〜400 文字 |
| `good` / `bad` | 各 1〜8 件 (必須)。`{aspect: ux / control / game, text: 1〜300 文字}` |
| `confusions` | 0〜8 件 (形は good と同じ) |
| `reflection` | 1〜8 行 (各 1〜300 文字) |
| `voluptasId` | Voluptas の記録 ID か null |

応答: 202 `{duplicate: false, unconfigured, delivered[], failed[], tabula}` (`tabula` は `{url}` / `{error}` / 設定で無効なら `null`)、同じ `runId` の再送は 200 `{duplicate: true, ...}`。

## 宛先 (状態の所有者は Cc の設定)

| 宛先 | 設定 | 送り方 |
|---|---|---|
| 本社 Discord | 設定 > Discord「AI プレイテスト通知チャンネル」(`discord.playtest_notify_channel_id`) | Cc Bot で投稿、`allowed_mentions: {parse: []}` |
| Slack | 設定 > AI プレイテスト通知「Slack webhook」(`playtest_notify.webhook_slack`、slack store に secret-box 暗号化) | Incoming Webhook、`sanitizeSlackMentions` |
| Tabula (任意) | 設定 > AI プレイテスト通知「Tabula にも投稿する」(`playtest_notify.tabula_enabled`、schema_meta)。接続先と取り込みトークンは技術相談と共用の `services.tabula_url` / `services.tabula_import_token` | 取り込み API (`importSharedPage`) にメンバー共有のページとして送る。冪等キー `playtest:<runId>`、題 `AI プレイテスト: <ゲーム名> (<persona>)`、タグ `ai-playtest` / `game:<id>` / `persona:<slug>`、本文は Discord と同じ投稿文 |

Discord / Slack の配送は [デプロイ反映通知](service-deployed-notify.md) と同じ transport (`deliverDeploymentNotice` / `createDeploymentDelivery`)、
Tabula は [技術相談](tech-consultation.md) §5 と同じ取り込みクライアント (`src/consultation/tabula-client.ts`)。
子会社・プロジェクト別の追加宛先は持たない (本社だけ)。

## 不変条件

- **CC-PLAYTEST-INV-01** 送り手は宛先・URL・Bot token を持たない。宛先は Cc の設定だけが決め、API は秘密を返さない。
- **CC-PLAYTEST-INV-02** 同じ `runId` は 1 回だけ配送する。台帳はこのプロセスの直近 1000 件 (`src/playtest-review/recent-run-ledger.ts`)。
  Ingenium は 1 run で 1 回だけ送り、送り直すのは応答を受け取れなかったときだけなので、再起動を跨ぐ重複までは防がない
  (DB の migration を足さない判断。重複が問題になったら番号付き migration で台帳を DB に移す)。
- **CC-PLAYTEST-INV-03** 良い点と悪い点のどちらかが欠けた感想は受け付けない (400、配送しない)。
- **CC-PLAYTEST-INV-05** Tabula への投稿は設定で有効なときだけ行い、チャットの成否に関係なく同じ投稿文を 1 run 1 ページ (冪等キー) で載せる。\n  有効なのに接続先かトークンが無い・取り込みが失敗したときは `tabula: {error}` を返し、チャットの配送は止めない。チャットの宛先が無くても Tabula が有効なら `unconfigured` にしない。\n- **CC-PLAYTEST-INV-04** 宛先が 1 つも設定されていなければ配送せず `unconfigured: true` を返す。1 つの宛先の失敗は他を止めず、宛先ごとの `failed` を返す。
  本文 (LLM が書いた文) の mention は配送側で無効化する。

## 投稿文 (`composePlaytestReviewNotice`)

ゲーム名 / 遊び方・画面の種類・判断回数・tick・結果 / 総評 / 👍 良い点 / 👎 悪い点 / ❓ 迷ったところ (あるときだけ) / 🔁 AI の反省 / Voluptas 記録 ID。
2000 文字で切る。

## 復旧

投稿が失敗したら、宛先ごとの `failed` が送り手 (Ingenium) の出力に残る。同じ `runId` は Cc が動いている間は受け付けないので、
送り直すときは Ingenium を新しい run で回す。宛先の設定を直せば次の run から届く。
