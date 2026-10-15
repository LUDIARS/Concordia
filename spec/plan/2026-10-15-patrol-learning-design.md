---
type: plan
title: "巡回チャット: ユーザーの発言からの断片と 1 日ごとの学習ルール (自動反映)"
service: concordia
status: implemented
related:
  - spec/feature/patrol-chat.md
  - spec/plan/2026-10-15-patrol-subsidiary-rules-design.md
updated: 2026-10-15
---

# 巡回チャットの学習

neco 2026-10-15: 「ユーザーの投稿に合わせて AI の会話ルール調整する。発言内容単体で断片つくり、1 日単位とかでまとめて学習ルール作る。
返信は即お願い」。反映は「自動で反映」(同日)。

## 1. 断片 (発言 1 件ごと)

- 対象: 巡回の会話へ受理された人間の返信 (`rule_inbound`)。返信の応答 (即時) とは別に、15 秒ごとの保守で後から抽出する
  (返信を待たせない)。1 回の保守で抽出するのは最大 2 件、rule ごとに 1 日 20 件まで。
- 抽出は `claude -p` (haiku・tools 無効・会話専用・1 回)。発言は資料として渡し指示として扱わせない。出力は型付き JSON:
  `{ genres: string[], sentiment: "positive"|"neutral"|"negative", request: string|null, tone: string|null }`。
  原文は保存しない。失敗・不正な出力は `status=failed` の断片として残し、再試行しない。
- 会話が閉じたとき、投稿への反応 (人数・良い/悪い) と返信数から決定的な断片を 1 件作る (LLM なし)。
- 判定 (投稿するか・何を選ぶか) には使わない (CC-PATROL-01 は維持)。巡回自身・bot の発言は対象外 (CC-PATROL-04)。

## 2. 学習ルール (1 日ごと・自動反映)

- ローカル 04:00 以降の最初の保守で、rule ごとに 1 日 1 回 (`patrol_learning_runs` の (rule, day) UNIQUE)。
  未使用の断片が 3 件未満なら見送り (skipped)。
- `claude -p` (haiku・1 回) に断片の要約と現在の設定を渡し、調整案を JSON で受ける。検証して範囲内だけを版付き更新で反映:
  - `filters.prefer_genres` (Tendentia の既知ジャンル) / `filters.prefer_ratio` (0.5〜0.9)
  - `learned.instructions` (200 字以内。rule の instructions とは別枠で生成に渡す。毎回置き換え)
  - `persona_hint` (80 字以内)
  - `tick_sec` は現在値の 0.5〜2 倍かつ 600〜86400 秒、`root_limit_per_day` は 1〜hard cap
- 変えないもの: 素材元・scope・持ち主・投稿先・時間帯・有効/無効・追投稿の閾値。
- 反映は `rule_versions` に actor=`learning` で残り、`/rules` の「版」から戻せる。結果 (applied / skipped / rejected / failed) と
  案は `patrol_learning_runs` に残る (`GET /v1/rules/:id/learning`)。`action_config.learning.enabled=false` で rule ごとに止める (既定は有効)。

## 3. 会話の取り込み (neco 2026-10-15「全部拾う」「リプライじゃない普通の会話に即反応はしなくていい」)

- 巡回の投稿先チャンネル (有効な巡回 rule の実効 `discord_channel_id`) の人間の発言は、返信でなくても chat 行にする
  (`metadata.patrol_discord_channel_id`、`in_reply_to` なし)。即応はしない。後続発言の数 (追投稿の判定) と断片の材料にする。
  本社の Discord / Slack には転記しない。本文は本社 DB に残る。

## 4. 話題の点数 (neco 2026-10-15「サーバに近い話題は高く、直近 3 日に話した内容は低く、日ごとに緩和」)

- 点数 = 鮮度 (0〜3) + サービス一致 + 関心キーワードの関連度 (0〜3) − 直近の話題の減点 (今日 3 / 昨日 2 / 一昨日 1)。決定的。
- 関心キーワード = rule の `topic_keywords` ∪ 持ち主の子会社の既定値 `topic_keywords` ∪ 学習した `learned.keywords`。
  例: GLab は TGS 出展作 (マルチパーティゲーム・リズムゲーム・ローグライトのカード/アクション)。
  子会社の管理者は `/patrol defaults-set keywords:` と Web の既定値パネルで設定する。
- 直近の話題 = 直近 3 日に投稿した素材の題 + 会話の断片の話題キーワード。文字 2-gram の重なり (≥0.35) かキーワードの包含で近いとみなす。
- 断片は話題キーワード (`keywords`) も持ち、学習は 2 回以上出たキーワード上位 10 を `learned.keywords` に置き換える。

## 5. 人格 (neco 2026-10-15「ちょっとむかつくのでペルソナエンジン使って個性出して」)

- Discutere のペルソナエンジンと同じ形 (性格・話し方) の人格 8 種 (`patrol-characters.ts`) から、会話の最初の投稿で seed により 1 人選び、
  返信・追投稿は引き継ぐ (`decision.character` / `metadata.patrol_character`)。
- 生成の指示に人格と「『〜んですね』『〜ですよね』で書き出さない・無難にまとめない・自分の意見を一つ入れる」を入れる。
- Discutere のペルソナエンジンは外部 API を持たず、ペルソナ正本の Histrio は未実装のため、同じ形を Cc の巡回に持つ。Histrio 稼働後に移す。

## 6. 返信

- 返信は従来どおり期日を待たずに次の周期で応える。新規投稿しない時間帯でも返信は止めない。断片の抽出は返信の後で行う。
