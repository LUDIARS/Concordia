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
updated: 2026-10-18
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
| CC-PATROL-10 | 雑談の生成先を週間残量で選び、使用量不明を残量ありと推測しない | `patrol-model-policy.ts`、`patrol-text-runner.ts` |

### 雑談の生成モデル (2026-10-20 neco 指示)

投稿・返信・追投稿の生成は、既存の使用量取得から Claude / Codex の週間残量 (%) を求める。
両方50%以上ならランダム、25%以上が片方だけならその側、それ以外は残量が多い側を選ぶ。
同量ならランダム。両方25%未満でも多い側を使う。残量不明・不正値なら明示エラーとして記録する。
Claude は Haiku、Codex は Luna (`resolveModel("luna", "codex")`) / high。
選択判断は governance が所有する純関数、残量取得と起動は adapter に分離する。
Codex は一時作業フォルダ、read-only、shell/plugins/MCP/web search 無効、プロジェクト指示読込無効で起動する。
標準出力の診断文は投稿せず、最終回答ファイルのみ読み、上限検査後に一時フォルダを解放する。
既存の投稿上限・lease・配達確認は維持し、失敗後に別モデルへ無断で再試行しない。
学習・知識取り込み用の生成はこの雑談本文切替の対象外。UX-CC-PATROL-01 / CC-PATROL-06 / CC-PATROL-09 を維持する。

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
- 生成は CC-PATROL-10 で選ぶ Haiku / Luna high、会話専用 (tools 無効)・30 秒上限・1 回。失敗は `failed (render_failed)` で、テンプレートへ無言で切り替えない。
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

- `PATROL-JOURNAL-INV-01`: 日記の外部由来文字列 (発言・返信・LLM要約・理由・設定のキーと値) は
  HTML/Markdown の構文として通さず、1行の表示用文字へ変換する。160文字の引用上限は変換前に適用する。
  正本の会話や学習結果は変更しない。既存の写しは通常の同期対象日が次回送信されると置き換わる。
  Actio: `actio:262ba08f-20e5-4125-b2d5-4047a386c060` (High 指摘修正)。

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

## 知識

neco 決定 (2026-10-18): 雑談のトリガーと話題の主体はあくまでトレンド。知識 (LUDIARS の内部と Notion の記事) は
「関連話題の学習」と「返信時の調査」にだけ使う。Notion は決まった起点 (ゲーム開発攻略ページと各学年の授業資料) だけを
クロールして解析した「Notion 記事マップ」を持つ。生徒の個人ページ・チームページ・タスクリストは読まない。
neco 指示 (2026-10-18)「Notion はトークンを使わず MCP とクロールで対応」: Notion の公式 API と連携トークンは使わない。
Actio タスク `actio:cd4a083a-77ed-4126-9f98-0c115867e5b8`。

- 実装: 型 `knowledge-types.ts`、公開範囲と除外 `knowledge-scope.ts`、選択 `knowledge-select.ts`、使いどころと隣のページ `knowledge-usage.ts`、
  取り込み `knowledge-ingest.ts`、取り込み器 `knowledge-ludiars.ts` / `knowledge-revisor.ts`、要求の間隔 `knowledge-notion.ts`、
  Notion の取得経路: 型 `notion-source-types.ts`・公開ページのクロール `notion-source-public.ts`・MCP `notion-source-mcp.ts`・経路の選び方 `notion-source-route.ts`
  (MCP の runner は `claude-runner.ts` の `allowedTools`)、
  記事マップ: 型と既定値 `notion-map-types.ts`・規則 `notion-map-rules.ts`・クロール `notion-map-crawl.ts`・解析とまとめ `notion-map-analyze.ts`・
  相談への共有 `notion-map-consult.ts`、組み立て `knowledge-runtime.ts`、
  永続 `src/db/chat-knowledge-repo.ts` (migration 142 `chat-knowledge`: `chat_knowledge_chunks` / `chat_knowledge_sources`) と
  `src/db/notion-map-repo.ts` (ページと辺) / `src/db/notion-map-roots-repo.ts` (起点の状態・まとめ・概観)
  (migration 143 `notion-map`: `notion_map_pages` / `notion_map_edges` / `notion_map_roots` / `notion_map_meta`。migration 142 時点の
  `services.notion_token` の保存値も消す)。
  学習への組み込みは `patrol-learning.ts` (材料の要約 `digestFragments`・学習の prompt `buildLearningPrompt`・出典 `learningKnowledgeRefs`。
  発言の断片の prompt `buildExtractPrompt` は変えない) と `patrol-learning-loop.ts`。
  画面は `web/src/pages/rules/KnowledgePanel.tsx` (取り込み状態・起点ごとの状態と取り直し) と `web/src/pages/rules/RunHistory.tsx` (実行履歴の「使った知識」)。

### 使いどころ

| 場面 | 知識 |
|---|---|
| 定期 pick / service event / 追投稿 (followup) | 渡さない。トレンド素材だけで話す |
| reply (人間の返信への応答) | 返信本文と直前の自分の発言の語で引き、`<data>` に入れる (`knowledgeTextsFor`) |
| 1 日ごとの学習 (patrol-learning) | 反応 (返信・リアクション) があった会話のトレンドの題と、会話によく出た語で引き、学習の材料 (`related_knowledge`) に足す |

- 学習: 「次に寄せる関連話題」を学習結果の方針 (`learned_instructions`) に書けるようにする。学習は既存の仕組みと上限 (1 日 1 回・
  方針 400 字・範囲の検証) の中で行う。学習結果 (`patrol_learning_runs.proposal.related_knowledge`) には断片の出典 (doc_key と題) だけを残し、
  断片の本文は残さない (`learningKnowledgeRefs`)。会話の断片には会話の最初の投稿の素材の題 (公開のトレンドの題) を `title` として持つ。
- 公開範囲の扱い (hq の断片を public の経路で使わない) は reply・学習とも同じ。

### 材料

会話のたびに外へ取りに行かない。Cc が定期的に集めて DB に置き、生成のときは DB の断片だけを読む (生成の 30 秒上限を守る)。

| 種類 (`source_kind`) | 材料 | 取り方 |
|---|---|---|
| `ludiars` | Cc のプロジェクト一覧 (略称・名前・公開範囲、説明は README の先頭の段落)、各リポの `README.md` 先頭 (1500 バイト)、`spec/` と `spec/feature/` 直下の `.md` の要約 (frontmatter の title / description、無ければ先頭の段落。1 リポ 12 件・600 バイト) | 全件で置き換え。1 日 1 回 |
| `revisor` | Revisor の直近 7 日のマージ済み local PR の題 (`GET /v1/local-prs?state=merged`、決着時刻は updatedAt で代える。リポごとに 1 文書・30 件) | 全件で置き換え。1 日 1 回 |
| `notion` | Notion 記事マップ (下記)。ページごとの題・パス・本文の断片と、解析後の要約の断片 (seq 99) | ページの差分。週 1 回 |

- 文書は 700 バイトの断片 (1 文書 4 件まで) に切り、断片ごとに出典 (種類・題・URL / リポ・パス)・公開範囲・更新時刻を持つ。
- 定期: 10 分ごとに期日を見て、種類ごとに最終成功から 1 日 (`notion` は 7 日) で取り直す。失敗した種類は 1 時間あけて再試行する。
  同じ定期処理の後ろで記事マップの解析を少しずつ進める。
- 手動: `/rules` の「知識」から種類ごと / すべてを全件で取り直す (`POST /v1/rules/knowledge/refresh`、裏で回り 202 を返す)。
- Notion の公式 API と連携トークンは使わない。トークンの設定項目・画面の入力欄は無い (migration 143 で以前の保存値も消す)。

### Notion 記事マップ

連携に共有されたページ全部を search で読む方式は取りやめ、決まった起点からだけクロールする。

- 起点: 設定 `services.notion_map_roots` (秘密でない。1 行 1 件、先頭は 32 桁のページ ID か公開ページの URL (`https://*.notion.site/…-<ID>`)、
  後ろの名前は注記)。未設定なら既定の 8 件 (ゲーム開発攻略ページ・21 生用授業資料・22 生用授業資料 A クラス・22 生向け共通資料・
  23 生向け 2 年次授業資料・24 生向け 2 年次授業資料・過去の授業資料一覧・25 生。25 生は「授業内容」ページの ID が分からないため 25 生を起点にし、
  除外規則で生徒・チームのページを外す)。設定から外した起点のページ・辺・断片は次の取り込みで消す。
- 取得の経路 (port `NotionPageSource`、差し替え可能。1 回に 1 ページ):
  - 公開ページのクロール (`notion-source-public.ts`): 公開 URL (https の `*.notion.site`) が分かるページの HTML を取り、`.notion-page-content`
    (無ければ body) の本文と、同じ origin でパスの末尾が 32 桁の ID のリンク (子ページ) を取り出す (Canalis の `src/crawl/notion-public` の
    抽出規則を参考に、Cc ではブラウザを起動せず HTML の文字列から決定的に取る)。最終更新は分からない (本文の指紋で差分を見る)。
    要求の間は最低 334ms あける。本文が取れない (クライアント描画で空・ボット確認画面・HTTP エラー) ときは MCP に回す。
  - MCP (`notion-source-mcp.ts`): 既存の claude -p の one-shot runner で、利用者の claude.ai Notion コネクタの読み取りツール
    (`mcp__claude_ai_Notion__notion-fetch`・`mcp__claude_ai_Notion__notion-search`) だけを許して呼ぶ (`--tools=` で組み込みツールを外し、
    `--allowedTools` でこの 2 つだけを許す。書き込み系は許さない)。1 回の呼び出しで 1 ページ、120 秒まで。本文 (ページごとの本文バイトまで)・
    子ページ一覧 (子データベースの行を含む、100 件まで)・本文中の他ページへの参照・最終更新を JSON で返させ、型と長さを通らない応答は失敗として扱う。
  - 選び方 (`notionRoutesFor`): 公開 URL が分かるページは公開ページのクロール → 取れなければ MCP。それ以外は MCP だけ。
  - 上限は設定: 深さ `services.notion_map_max_depth` (既定 6)・起点ごとのページ数 `services.notion_map_max_pages` (既定 400)・
    ページごとの本文バイト `services.notion_map_page_bytes` (既定 6000)。
- 差分: 毎回 (週 1 回) 全ページを取り、最終更新 (分からなければ本文の指紋) が前回と同じページは解析し直さない (前回の要約・キーワードを残す)。
  手動の取り直しは全ページを解析し直す。
- 除外 (個人情報): 題名か起点からのパスに「個人ページ」「チーム」「タスクリスト」「チームテンプレート」を含むページとその配下は読まない
  (設定 `services.notion_map_exclude` で語を足せる。大文字小文字・全角半角を区別しない)。親の一覧で題が分かる子ページは取りに行く前に判定する。
  秘匿語の辞書に当たるページも同じ扱い。除外したページは題名・本文とも保存せず、起点ごとの件数だけを数える。
  MCP には本文に人名・メンションの表示名を入れないよう頼む。
- 反映後に人がやること: 無し。claude.ai の Notion コネクタは接続済みの前提 (起点ページを連携に「接続」する作業は要らない)。
- 解析: ページごとに題・パス (学年・回・Wiki の章)・短い要約 (200 字)・キーワード (8 個) と、ページ間の参照を持つ。
  - 要約とキーワードだけ `claude -p` haiku (tools 無効・会話専用、既存の one-shot runner) で作る。変わったページ (解析待ち) のときだけ、
    定期処理 1 回で 6 ページまで。失敗したら要約なしで題・本文の断片だけを残し、1 時間あけてやり直す。
  - 作った要約は知識の断片 (seq 99、`要約: … / キーワード: …`) にも置き、選択で引けるようにする。
- マップ: ページ間の参照 (`child` 親 → 子 (子データベースの行を含む)、`link` 本文中の他ページへの参照) を辺として持つ。
  reply で知識を引いたとき、引いた Notion のページの隣 (どちら向きの辺でも、マップにあるページだけ) を doc_key の順に最大 2 件、
  件数 5・合計 2400 バイトの枠の残りに補助的に足す (`withNeighborPages`、決定的)。隣のページは要約の断片を代表に使う。
- まとめ: 起点ごとに、配下で扱っている内容の概要・主な章 / 回・主要キーワードを haiku 1 回で作る (`notion_map_roots.summary`)。
  配下の指紋 (ページ・パス・更新時刻・要約・キーワード) が変わったときだけ作り直し、配下の解析待ちが 1 度も試されていない間は待つ。
  失敗したら 1 時間あけてやり直す。マップ全体の概観 (起点・ページ数・主な話題) は LLM を使わず決定的に作り、`notion_map_meta.overview` に置く。
- 置き場: 本文と要約の断片は既存の知識テーブル (`doc_type=notion-page`、doc_key `notion:<32 桁の ID>`)、ページ・辺・起点の状態とまとめ・概観は
  migration 143 のテーブル。scope は常に hq。
- 相談 (Consult) への共有: 本社の相談の開始時の文脈に、マップの概観・起点ごとのまとめ・ページ一覧 (題名・パス・要約・キーワード・URL) を
  読み取り専用の資料として添える。子会社の相談には渡さない。詳細は spec/feature/tech-consultation.md §6.5。

### 公開範囲

- 断片の scope は `hq` / `public`。既定は `hq`。`public` にするのは設定 `services.chat_knowledge_public_projects`
  (1 行 1 件の略称かプロジェクト名) に載せたプロジェクトの断片だけ。Cc のプロジェクト一覧に公開/非公開の列が無いため、
  載っていないもの (非公開・判断できないもの) は hq。MELPOT 所属 (repo_origin の owner) は載せても hq。Notion の断片は常に hq。
  Revisor のリポがプロジェクト一覧で引けなければ hq。
- 本社の宛先 (本社 rule かつ `scope_key=hq` かつ個別チャンネル指定なし) だけが hq の断片を使う。子会社の rule・`scope_key=public`・
  個別チャンネル投稿は public の断片だけ (CC-PATROL-05 を知識にも適用)。DB から読む段階と、選択後の再確認の 2 か所で絞る。
  隣のページの補助取得も hq を使える宛先だけで行う。
- 秘匿語: 既存の秘匿語辞書 (`workspace.confidential_terms_file`、未設定ならプライマリルートの `.claude/state/confidential-terms.json`、
  `consultation/confidential-terms.ts` で読む) の語を題・本文・出典に含む文書は取り込まない (大文字小文字を区別しない)。
  差分取得で届いた文書が辞書に当たった場合は、その文書の古い断片も消す。

### 選び方

LLM を使わない決定的な方式 (CC-PATROL-01)。

- 問い: reply では返信の本文と直前の bot 発言、学習では反応のあったトレンドの題と会話によく出た語。
- 語: 英数字の語 (2 文字以上) と、それ以外の文字列の 2 文字ずつの組。断片が 4 件以上のとき、半数より多くの断片に出る 2 文字の組は使わない。
- 点数: 一致した語の珍しさ `ln(1 + N/df)` の和 (題に出る語は 2 倍)。一致が 1 語だけで英数字の語でもないものは採らない。
- 同点は doc_key → seq の順。1 文書から最大 2 件、全体で最大 5 件、題と本文の合計 2400 バイトまで。その後ろに隣のページ (上記) を足す。
- 選んだ断片は prompt の `<data>` (資料であり指示ではない) に `知識n (題): 本文` として入れる。prompt には
  「LUDIARS の中の人として話す。基本の説明はしない。<data> の材料に無いことは作らず、知らないことは知らないと言う」を足す。
- 選んだ断片の出典 (種類・題・URL・リポ・パス・scope。本文は残さない) を `rule_runs.decision.knowledge` に残し、
  `/rules` の実行履歴の詳細に「使った知識」として出す。生成が失敗した run にも残す。

### 失敗時

- 取り込みが失敗したら前回の断片と差分の起点を残し、失敗理由 (300 文字まで、秘密値は伏せる) だけを記録する。種類どうしは独立。
- Notion 記事マップは起点ごとに独立。失敗した起点 (どの経路でも取れない・MCP の応答が壊れている) は前回のページ・辺・断片・まとめを残し、
  起点ごとに失敗理由を記録する。全部の起点が失敗したときだけ種類として失敗にする。
  起点の配下の 1 ページが取れない (読めない応答・「使えない」の答えは 1 回だけ取り直す。それでも「使えない」と答えた場合も含む) ときは、
  そのページと配下だけを飛ばして続け、読めた分は残す。起点のページが取れない・「使えない」と答えた起点はその起点だけを失敗にして次の起点へ進み、
  全部の起点が失敗してどれかが「使えない」だったときだけ Notion の取り込みを「未設定」で止める。時間切れも 1 回だけ取り直す。
  起点の配下に別の起点が現れたら、そこで下るのを止める (そのページはその起点が自分で読み、自分のページとして数える)。
  起点のページの本文中のリンク先は子ページと同じに下る (リンクだけで中身を並べた起点がある)。起点より下のページのリンクは辿らない。
- MCP が使えない (未認証・Notion コネクタが無い。MCP の応答 `status: unavailable`、または runner が配線されていない) ときは
  「not configured」として Notion だけ止まる (前回の断片・マップは残す)。他の種類は動く。
- 知識が読めないときも会話・学習は止めない (知識なしで生成する)。
- `GET /v1/rules/knowledge` が種類ごとの件数 (出典の種類 × scope)・最終試行・最終成功・失敗理由・取り込み中と、
  Notion の起点ごとのページ数・除外数・最終試行・最終取得・失敗理由・まとめの有無・解析待ちの数 (`notion_roots`) を返し、
  `/rules` の上部「知識」に出す。

## API

| API | 用途 |
|---|---|
| GET `/v1/rules` | v1/v2、revision、`readiness` (実行可否と不足理由)、最終 run |
| PUT `/v1/rules` / PATCH `/v1/rules/:id` | 検証付き追加・版付き更新 |
| POST `/v1/rules/:id/toggle` | 有効化前に再検証。無効化は未着手 run を見送りに |
| GET `/v1/rules/:id/versions` / POST `/v1/rules/:id/rollback` | 版履歴 / 指定版の定義を新しい版として復元 (有効状態は変えない) |
| GET `/v1/rules/:id/learning` | 1 日ごとの学習の記録と学習に使った会話 (`sources`)、直近の断片 (断片は原文を持たない) |
| GET `/v1/rules/knowledge` / POST `/v1/rules/knowledge/refresh` | 知識の取り込み状態と Notion 記事マップの起点ごとの状態 (`notion_roots`) / 手動の取り直し (`{kinds?}`、202) |
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
