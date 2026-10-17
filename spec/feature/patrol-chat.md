---
type: feature
title: "巡回チャット — 素材起点のルール投稿・返信・追投稿"
description: "既存の rule engine (rules / rules_log / /v1/rules) を拡張し、決定的なルールで素材 (Tendentia の公開トレンド・サービスの出来事) を選んで短い一言を投稿する。返信には即応し、無返信なら反応の人数・後続の発言数で一度だけ追投稿する。判定に LLM を使わず、文の生成だけを 1 回行う。設定は版付きで、Cc の /rules 画面でルールと実行履歴を確認できる。"
service: concordia
domain: governance
tags:
  - rule-engine
  - chat
  - patrol
  - tendentia
  - webui
status: implemented
related:
  - spec/plan/2026-10-15-patrol-chat-implementation-design.md
  - spec/feature/blackbox-chat-engine.md
updated: 2026-10-15
---

# 巡回チャット

設計の経緯と根拠は [実装引継ぎ設計](../plan/2026-10-15-patrol-chat-implementation-design.md)。本書は実装済みの契約を記す。
数値の初期値は設計案であり、人間が承認した値ではない。UX の評価は未測定。

## 価値とシナリオ

| ID | 価値 | 評価 |
|---|---|---|
| UX-CC-PATROL-01 | 素材の出典と投稿理由を確認でき、少ない消費で会話に参加できる | 未測定 (draft) |

関連: `UX-CC-PRODUCT` の「つぶやきと会話」、`UX-CC-W4` (注意・コスト・配達)、`UX-CC-W5` (停止・復旧)。

1. 定期: 巡回ルールが期日に素材元から候補を読み、決まった点数付けで 1 件を選び、短い一言と出典 URL を投稿する。
2. 報告: サービスが `POST /v1/rules/service-events` へ出来事を送ると、型付きの filter に合う巡回ルールが短く報告する。
3. 返信: 人間が巡回の投稿へ返信すると、定期の期日を待たずに応答する (同じ返信へは一度だけ)。
4. 追投稿: 返信が無くても、反応した人数か後続の人間の発言数が閾値を越えたら、一度だけ短い一言を足す。
5. 確認: Cc の `/rules` 画面でルール・素材元・実行履歴 (素材・本文・理由・配達) を見て、版を戻せる。

## 境界

- 所属: 支援 domain `governance` (rule 制御)。配送は既存 `chat-platforms` (chat.posted → egress)、HTTP は `http-interface`。
- 業務判断: `src/rules/patrol-policy.ts` (純関数)。設定検証: `patrol-config.ts` / `rule-validation.ts`。
- 手順: `execute-patrol.ts` / `patrol-cycle.ts` / `patrol-inbound.ts` / `patrol-maintenance.ts` (port `patrol-ports.ts` のみに依存)。
- adapter: 素材 `material-tendentia.ts`、素材元 allowlist `material-registry.ts`、生成 `render-patrol.ts`、組み立て `patrol-runtime.ts`。
- 永続: `rule_runs` (実行)、`rule_conversations` / `rule_conversation_messages` / `rule_inbound` (会話)、`rule_versions` (版)、
  `rule_service_events` (受信箱)、`rules` の v2 列。migration 138 `patrol-chat-rules`。
- 旧 `blackbox-chat-engine.md` の persona・描画の Histrio 移管方針は取り消さない。今回の素材起点巡回は Cc に現存する engine を拡張したもので、
  生成 port (`render`) は将来 Histrio の実装へ差し替えられる。

## 不変条件

| ID | 不変条件 | 主な担保 |
|---|---|---|
| CC-PATROL-01 | 判定に LLM を使わず、時刻・乱数 seed・観測から再現できる | `patrol-policy.ts`、run に seed / 候補数 / score を保存 |
| CC-PATROL-02 | 投稿前に rule revision / trigger / 素材 / 宛先 / run を保存する | `rule_runs` の各境界、chat 行と chat_message_id を同一 transaction |
| CC-PATROL-03 | 同じ trigger は一度だけ受理し、結果不明の外部送信を自動再送しない | `trigger_key` UNIQUE、`rule_inbound` PK、配達は照合のみ |
| CC-PATROL-04 | 自分の出力を素材・後続投稿・返信として再投入しない | metadata.source=`patrol`、人間判定 (`isHumanMessage` / `countHumanAfter`) |
| CC-PATROL-05 | scope と素材の共有範囲が宛先に適合する | allowlist の scopes、`reviewPatrolConfig`、`pickMaterial` の shareableTo |
| CC-PATROL-06 | runtime OFF / rule 無効 / 予算超過 / lease 喪失後に新規生成・送信を始めない | `stopReason`、送信直前の `sendBlocker`、lease CAS |
| CC-PATROL-07 | 返信・追投稿は上限と hard cap を越えない | `canReply` / `evaluateFollowup`、`PATROL_HARD_CAPS` |
| CC-PATROL-08 | 編集は revision を増やし、実行は取得時の版を固定。無効化は固定版より優先 | `updateWithRevision`、run.rule_revision、送信前の現在値再読 |
| CC-PATROL-09 | 素材なし・素材元エラー・生成失敗・投稿・配達・結果不明を別状態で残す | `RunStatus`、error_code、画面の状態名 |

## ルールの拡張

- `rules` に `config_version` (1=旧, 2=巡回)・`revision`・`execution_mode` (`legacy-observe` / `patrol`)・`action_config` (JSON)・
  `next_due_at`・`last_attempt_at`・`last_posted_at` を追加。既存 rule は `legacy-observe` のままで投稿副作用を持たない。
- `action_config` は `kind=material-chat` の型付き設定 (素材元 ID・scope・filter・生成方式・日次上限・追投稿条件)。
  未知キーは拒否、上限は hard cap 以下。URL / SQL / ファイル / credential は書けない (素材元は allowlist の ID だけ)。
- 巡回の event rule は `event_kind=service.event` で、`service_codes` / `feature_keys` / `event_kinds` のいずれかの filter を必須にする。
- PUT / PATCH / toggle (有効化) / rollback は更新後の全体を `validateRuleDefinition` で検証する。巡回 rule の PATCH は
  `expected_revision` 必須 (無ければ 428、不一致 409)。巡回 rule の PUT は明示しない限り無効で保存する。
- assist は draft を返すだけで、保存・有効化しない (従来どおり)。

## 素材元

| sourceId | 状態 | 契約 |
|---|---|---|
| `tendentia-public-trends` | 接続先 `TENDENTIA_URL` (Excubitor topology) があれば ready | `GET /api/trend-crawler/overview` を読むだけ。error / fetchedAt の無い source は採らない。個人の interest / click は読まない。crawl を起動しない |
| `corpus-activity` | `contract-unverified` (選択不可) | Corpus 本体に共通の活動 feed を確認できていない。所有サービスの活動 API・scope・保持期間を確認してから adapter を追加する |

素材取得の失敗は空配列ではなく `MaterialSourceError` (auth / schema / timeout / unavailable / not-configured / contract-unverified)。

## 実行

engine の 1 秒 tick ごとに、巡回 rule を 1 本ずつ `runPatrolCycle` する (旧 rule とは別の mutex)。優先順位は固定:
停止 → 未処理の直接返信 (最大 3 件をまとめる) → service event → 追投稿 → 定期 pick → 理由付き skip。

- 定期の期日は `next_due_at`。初見の rule は即発火させず、rule ID 由来の jitter (間隔の 10% 以内) で次回を決める。
  深夜帯は間隔を 1/頻度 倍に伸ばす。返信は深夜帯でも待たせない。
- 新規投稿しない時間帯 `action_config.quiet_hours` (`{start,end}` の HH:MM、サーバのローカル時刻、日付またぎ可、既定 22:00〜09:30、
  null で時間帯なし。neco 2026-10-15「深夜帯～始業までは新規投稿しない。返信はする」)。時間帯の中は返信だけを行い、
  定期 pick・service event・追投稿は出さない (`skip: quiet hours`)。定期の期日は通常どおり進め、event は受信箱に残って時間帯明けに出る。
- 状態: `claimed → material_selected → rendering → rendered → delivery_pending → delivered | delivery_unknown`、
  途中で `skipped` / `failed`。各遷移は lease_owner と現状態の compare-and-set。
- 生成は `claude -p` 会話専用 (tools 無効)・haiku・30 秒上限・1 回。失敗は `failed (render_failed)` で、テンプレートへ無言で切り替えない。
  失敗理由には stderr と stdout の先頭を残す (両方空なら `no output` と書く)。
  定期 pick の生成が失敗したときは、次の期日を通常の間隔ではなく 15 分後 (`PATROL_RETRY_AFTER_FAILURE_SEC`) に置き直す。
  失敗が続くあいだは 15 分・30 分・1 時間・2 時間と倍にし、通常の間隔で頭打ちにする (使用上限のように数時間続く失敗で 1 日の生成上限を使い切らない)。
  間隔が 15 分以下の rule では置き直さない。新しい期日は別の trigger_key なので同じ run の再送ではなく、回数は 1 日の生成上限が縛る。
- 名乗り (`patrol-persona.ts`): 会話の最初の投稿 (pick / event) は、同じ 1 回の生成で 1 行目に「名前: 姓 名」を書かせ、
  話題をもじった珍しい日本人風の名前を毎回付ける (Discutere の役名 `押野 進` 等と同じ流儀)。返信・追投稿は会話の root の名乗りを引き継ぐ。
  名前は 2〜16 文字で、mention・URL・Discord が webhook 名に禁じる語・記号を含むものは採らず、決まった一覧から素材の題で決定的に選ぶ。
  名乗りは `rule_runs.decision.persona` に本文と一緒に保存し (復旧時も同じ名前で確定)、chat 行の `author_label` と
  `metadata.patrol_persona` / `metadata.webhook_username` に `<名前> (巡回)` として載せる。表示だけに使い、判定には関わらない。
- 15 秒ごとの保守: lease 切れの run を復旧 (rendered は保存済み本文で投稿を確定、rendering は `render_interrupted` で失敗確定)、
  配達照合、期限切れ会話の終了、1 日以上前の未処理 event を ignored に。
- 配達: 既存 egress が chat.posted で送信し、成功時だけ `discord_message_map` に記録する。記録が見つかれば `delivered`、
  投稿後 10 分見つからなければ `delivery_unknown`。不明は 1 日照合を続けるが、自動では再送しない。
- 停止: engine.stop は新しい周期を止め、送信直前の検査で投稿させない。生成途中の run は次回起動時に `render_interrupted` として残る。

## 個別チャンネル

- `action_config.discord_channel_id` (Discord channel ID、既定 null) で投稿先を rule ごとに指定できる。null なら `rule.target` の meta channel。
  `/rules` の編集画面はチャンネル URL (`https://discord.com/channels/<guild>/<channel>`) か ID を受け、ID にして保存する。
- 指定した rule は `scope_key=public` に限る (子会社 guild など本社外へ本社限定の素材を出さない、CC-PATROL-05)。
- 指定した投稿は chat 行 (`metadata.patrol_discord_channel_id`) を残すが `chat.posted` を出さず、本社の Discord meta / Slack 配信に流さない。
  `patrol-external-delivery.ts` が本社 Bot の token で直接送る (子会社 guild には本社と同じ Bot が招待されている)。
  - 宛先 guild は本社 guild と有効な子会社 guild (`subsidiaries.guild_id`) に限る。それ以外は送らない。
  - チャンネルの巡回用 webhook (`Concordia 巡回`) を使って名乗りで投稿する。webhook を作れなければ Bot 本人の投稿に名乗りを太字で前置する。
  - 成功時だけ `discord_message_map` に記録し、配達照合で `delivered`。失敗は自動再送せず `delivery_unknown`。
- 個別チャンネルでの返信: meta channel でないチャンネルの発言は通常捨てるが、巡回投稿 (`discord_message_map` にある) への
  Discord 返信だけは `src/discord/patrol-reply-ingress.ts` が chat 行にする (返信先の巡回投稿の `patrol_discord_channel_id` が
  発言チャンネルと一致する時だけ)。chat 行は `metadata.patrol_discord_channel_id` を持ち、本社の Discord (source=discord) /
  Slack へ転記しない。返信でない雑談は取り込まない (本社 DB に子会社の雑談を溜めない)。
- 会話の受理と追投稿の数え方は宛先チャンネルで分ける: 個別チャンネルの会話は同じチャンネルの返信だけを受け、
  後続の人間の発言はそのチャンネルの chat 行だけを数える (`countHumanAfter(channel, afterId, externalChannelId)`)。
  本社の会話は個別チャンネルの発言を数えない。個別チャンネルでは雑談を取り込まないので、後続発言による追投稿は実質起きない。
- 個別チャンネルの反応 (リアクション) は、子会社の Bot が受けて `discord_message_map` で巡回投稿へ結び付けられた場合だけ数える (未検証)。

## 子会社単位の設定

設計: [patrol-subsidiary-rules](../plan/2026-10-15-patrol-subsidiary-rules-design.md)。

- `rules.subsidiary_id` (NULL = 本社) で rule を子会社に紐付ける (migration 139)。子会社の rule は `scope_key=public`、
  個別チャンネルの配送先は持ち主の guild だけ (本社 rule は本社 guild)。`GET /v1/rules?subsidiary_id=|head_office=1`。
- 子会社ごとの既定値 `subsidiary_patrol_defaults` (`quiet_hours` / `root_limit_per_day` / `discord_channel_id` / `persona_hint` / `paused`)。
  rule の action_config に**書かれていない**項目は 子会社の既定値 → 全体の既定値 (時間帯なし・8 件/日・投稿先なし・雰囲気なし) で埋める。
  明示の null は「無し」。API は保存形 `action_config` と実行時の `effective_config` を分けて返す。
  `paused` と子会社自体の無効は返信も含めて新規の行動を止める。
- 子会社サーバー管理者の `/patrol` (Manage Guild 権限、子会社 guild にだけ登録): list / add / set / on / off / defaults / defaults-set。
  `/v1/subsidiaries/:id/patrol/*` だけを呼び、持ち主が違う rule は 404。素材元・scope・持ち主は変えられない。変更者は `discord:<id>` で版と rule_log に残る。

## ジャンル

- Tendentia の overview は総合ジャンルが先頭に並ぶ。上限 (100 件) はジャンルを交互に並べてから掛け、`filters.genres` は上限の前に絞る
  (以前は先頭から切っていたため、ゲーム・技術などのジャンルが候補に入らなかった)。
- `filters.prefer_genres` / `prefer_ratio` (既定 0.7): 絞り込みではなく寄せる。seed 由来の乱数で prefer_ratio の確率だけ優先ジャンルの候補から選ぶ。

## 返信と反応

- Discord の meta channel で返信 (reference) した発言は、`discord_message_map` で既知の chat 行へ解決して `in_reply_to` を付けて投稿する。
- 返信の受理は `rule_inbound` (inbound chat ID が PK)。巡回の bot 発言 (root と以降の発言) への、人間の・同じ宛先の発言だけを受ける。
- 追投稿は最後の bot 発言から最低待ち時間が過ぎ、直接返信が無く、悪い反応が良い反応を上回っていないときだけ。
  反応は人数で数える (`reactorsByMessage`: 同じ人の複数絵文字は 1 人、取り消しは反映)。後続の発言は人間起源だけを数える。
- 生成直前に追投稿の条件を再評価し、返信が来ていれば取り消す。

## 学習の記録

- 正本は Cc の `patrol_learning_runs` (rule × 日で 1 行。結果・要約・実際に変えた設定・材料にした断片の数・反映後の版)。
- Cc の画面: ルール一覧の巡回ルールの「学習」で、日ごとの記録を新しい順に見せる (`GET /v1/rules/:id/learning`)。
- 学習に使った会話: 学習 run が使った断片の元の発言を、表示のときだけ会話記録から引く (`sourcesForRun`)。
  発言 (返信・投稿先チャンネルの発言) は本文と返信先、会話は巡回の投稿・返信 (最大 10 件)・反応の人数。
  発言者の名前は出さない。会話記録から消えた発言は「残っていません」と出す。断片そのものは原文を持たないまま。
- Memoria: 学習の pass ごとに、直近 7 日の学習した日を見て、日ごとに全 rule の記録 (使った会話を含む) を日記の節
  `concordia-patrol-learning` へ置き換えで載せる (`PUT /api/diary/:date/sections/concordia-patrol-learning`)。
  Memoria は閲覧用の写しで、Cc の状態を変えない。
  - 前回送った内容 (run ID と結果の組) と同じ日は送らない。起動直後は送った記録が無いので、既にある日の分もここで載る。
  - 送れなかったらその pass はそこで止め、次の pass で送り直す。置き換えなので重複しない。

## API

| API | 用途 |
|---|---|
| GET `/v1/rules` | v1/v2、revision、`readiness` (実行可否と不足理由)、最終 run |
| PUT `/v1/rules` / PATCH `/v1/rules/:id` | 検証付き追加・版付き更新 |
| POST `/v1/rules/:id/toggle` | 有効化前に再検証。無効化は未着手 run を見送りに |
| GET `/v1/rules/:id/versions` / POST `/v1/rules/:id/rollback` | 版履歴 / 指定版の定義を新しい版として復元 (有効状態は変えない) |
| GET `/v1/rules/:id/learning` | 1 日ごとの学習の記録と学習に使った会話 (`sources`)、直近の断片 (断片は原文を持たない) |
| GET `/v1/rules/sources` | 素材元の ready/unavailable と最終取得 |
| POST `/v1/rules/preview` | 副作用・生成なしで候補と理由 |
| GET `/v1/rules/runs` / `/v1/rules/runs/:runId` | 実行履歴 (cursor) / 選択根拠・本文・配達・会話・版 |
| POST `/v1/rules/service-events` | 出来事の受信 (source_event_id で一度だけ、scope は hq/public) |
| GET `/v1/rules/log` | 既存互換。limit は 1〜200 |

## 残件

- Corpus 継承サービスの活動ログ: 対象サービスと公開活動 API の契約確認、adapter 追加。
- 配達台帳: egress 側に送信前の試行記録を足せば、送信後・記録前の中断を照合で区別できる (現状は `delivery_unknown` で止める)。
- Slack 等 Discord 以外の配達は照合していない (投稿 10 分後に `delivery_unknown`)。
- 変更主体は `human` 固定 (API に認証済み principal を渡す口が無い)。
