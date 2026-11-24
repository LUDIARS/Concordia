---
type: feature
title: "AI プレイテスト感想の投稿"
description: "Ingenium の ingenium playtest が渡す AI プレイテスト感想 (良い点・悪い点必須) を、Cc が設定した本社の Discord チャンネルと Slack webhook へ投稿する。送り手は宛先も秘密も持たない。"
service: concordia
domain: playtest-review-notify
status: implemented
updated: 2026-11-24
tags:
  - notification
  - ingenium
  - playtest
---

# AI プレイテスト感想の投稿

> 所属ドメイン: [`playtest-review-notify`](../domains/playtest-review-notify.domain.json)

2026-10-15 neco 指示: 「AIオートプレイヤーが画面と説明書を見て操作しながら、UX/操作感/ゲームの感想を投稿していく仕組みを Ingenium に用意。
Voluptas を通して匿名性の情報として扱う。プレイ時の感想・挙動・反省を Discord や Slack に投稿する。良い点と悪い点をちゃんと投稿する。」
続けて「Cc接続し、cc経由して投稿するようにしましょう」「プレイノートはローカルで貯めつつDiscordの投稿と設定でTabulaに投稿できる」。Actio `actio:c9464253-a17d-486a-8613-e8d12bf3a888`。

価値: UX-CC-W11 / シナリオ UX-CC-S12 ([プロダクト UX](../ux/product.md)、draft)。
送り手の仕様は Ingenium `spec/feature/playtest-review.md`、匿名保存は Voluptas `spec/feature/ai-playtest-reviews.md`。

## 口

`POST /v1/events/playtest-review` (`src/api/playtest-review.ts`)。認証は次節。

## CDGD 管理変更列と配送状況

Actio `78e07513`、Gen5 統合実装 `f69c01a2-02e0-4969-83c3-88e8d7d296f1`。
認証と本文検証を通過した感想は [CDGD の変更列](cdgd-management.md) に `ig:playtest-review:<runId>` で 1 件記録する。
同じ runId の再送で最初の記録を保持する。記録失敗はログに残し、配送の実行と HTTP 応答を維持する。
再送は管理列の記録を補える。Discord・Slack・Tabula の配送結果を記録し、[管制](control-session.md) が状態を読む。
管理列への保存とチャット・Tabula への配送の成否はそれぞれの所有者が記録する。

## 認証 (`src/playtest-review/playtest-review-auth.ts`)

2026-11-21 neco 指示 (本社作業依頼「cc-playtest の認証を x-excubitor-token (単一鍵) 方式へ」)。公開入口 `cc-playtest` から届く外部の送り手 (Muse) は
1 リクエストに秘密を 1 つしか載せられず、Cloudflare Access のサービストークン (ID と Secret の 2 ヘッダ) を送れない。そこでこのパスだけ Access を外し、
守りを Cc の受け口の鍵に一本化する。公開入口 (Excubitor intrusion gateway) 経由の要求も loopback の Cc に届くので、送信元では区別できない。

| 受け口専用の鍵 (設定 > AI プレイテスト通知「AI プレイテスト受け口の鍵」`playtest_notify.intake_token`) | 判定 |
|---|---|
| 設定あり | `x-excubitor-token` がこの鍵と一致するときだけ通す。無い・違う・長さ違いは 401。デプロイ通知と共有の鍵では通らない |
| 未設定 | 従来どおり: Discord 設定の `excubitor_dispatch_token` と一致すること。それも未設定なら loopback 運用 (`host` が 127.0.0.1 / localhost) のときだけ通す |
| 保存されているが読めない (secret-box の鍵の入れ替え等) | 全て 401 (未設定とみなして開けない) |

- 鍵は Muse 専用で、デプロイ・リリース通知が使う `excubitor_dispatch_token` とも他用途のトークンとも分ける (他の受け口の挙動は変えない)。
- 保管は Cc の DB (schema_meta、secret-box で暗号化) と設定画面の 1 系統。環境変数や Excubitor Vault には置かない
  (秘密は env から読まず DB + 設定画面に置く方針。Tabula 取り込みトークン等と同じ)。設定 API は実値を返さない。
  保存時に「空白を含まない 32 文字以上」を検証する。
- 比較は定数時間 (両辺を SHA-256 にして `timingSafeEqual`)。長さの違いも比較時間から漏らさない。
- 判定は bodyLimit の後、本文の読み取りとスキーマ検証 (400) の前。鍵が違う要求には本文の正否を返さない。
- 401 は `{error: "unauthorized"}`。Cloudflare Access の 302 / 403 と区別できる。401 のたびに warn ログ
  `playtest-review rejected an unauthorized request` を `{reason: missing | mismatch | unreadable | legacy_rejected}` だけで残す
  (鍵の値・提示値は残さない。本文を読む前なので runId 等も出さない)。
- 鍵を設定すると、同じ Cc へ送る他の送り手 (loopback の Ingenium) にも同じ鍵が要る。

ローテーション: 新しい値を設定画面で上書き保存すると、次の要求から新しい鍵だけが通る (古い鍵は即無効。再起動は不要)。
送り手 (Muse の Secure Vault 等) の値を同時に差し替える。消すと未設定 (従来の判定) に戻る。

### 設定画面からの保存 (2026-11-21 「設定ができない」の修正)

- 暗号化: schema_meta は `AdminState` が secret-box 付きの `EncryptedSettingsStore` で包むので、汎用 PUT (`src/config/settings/apply.ts`) が
  `writeMeta` で書いた鍵も `enc:v1` で置かれ、受け口 (`src/bootstrap/core.ts` → `readPlaytestIntakeToken`) は同じ store から復号して読む。
  secret-box が無い構成では schema_meta の secret を平文で置かず `backend_unavailable` で断る (`requiresEncryption` / `src/config/settings/db-bindings.ts` の `checkWritable`)。
- 保存先: 読み出しと書き込みは同じ規則 (`src/config/settings/store-of.ts` の `settingStoreOf`) で引き先を決める。セクション名だけで書き込み先を決めていたため、
  この画面の `playtest_notify.webhook_slack` (と デプロイ通知の `deploy_notify.webhook_slack` / `webhook_discord`) は schema_meta に書かれ、
  読む側 (slack_config / discord_config) からは見えない「保存したのに未設定」になっていた。
- 画面 (`web/src/pages/settings/sections/AllSettingsSection.tsx` / `SettingValueField.tsx` / `settingDraftCheck.ts`): 保存ボタンは一覧の上に貼り付けて
  下の項目からも見えるようにし、入力した項目に「未保存」、secret 欄に入力条件 (「空白を含まない 32 文字以上」) と、条件に合わない間の警告を出す。
  拒否 (400) はその項目の下にも理由を出し、保存できたら「N 件を保存しました」と「設定済み」を出す (値は読み返さない)。

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

run の動画を付けるときは `multipart/form-data` で、`review` に上の本文の JSON、`video` に mp4 (`video/mp4`、1 バイト以上
`PLAYTEST_VIDEO_MAX_BYTES` = 24 MiB 以下) を入れる。動画が条件を外れたら 400 `invalid_video`、本文全体が上限を超えたら 413。
ファイル名は英数字・`._-` 以外を `-` にして使う。

応答: 202 `{duplicate: false, unconfigured, delivered[], failed[], tabula, video}` (`tabula` は `{url}` / `{error}` / 設定で無効なら `null`)、同じ `runId` の再送は 200 `{duplicate: true, ...}`。

## 宛先 (状態の所有者は Cc の設定)

| 宛先 | 設定 | 送り方 |
|---|---|---|
| 本社 Discord | 設定 > Discord「AI プレイテスト通知チャンネル」(`discord.playtest_notify_channel_id`) | Cc Bot で投稿、`allowed_mentions: {parse: []}` |
| Slack | 設定 > AI プレイテスト通知「Slack webhook」(`playtest_notify.webhook_slack`、slack store に secret-box 暗号化) | Incoming Webhook、`sanitizeSlackMentions` |
| Tabula (任意) | 設定 > AI プレイテスト通知「Tabula にも投稿する」(`playtest_notify.tabula_enabled`、schema_meta)。接続先と取り込みトークンは技術相談と共用の `services.tabula_url` / `services.tabula_import_token` | 取り込み API (`importSharedPage`) にメンバー共有のページとして送る。冪等キー `playtest:<runId>`、題 `AI プレイテスト: <ゲーム名> (<persona>)`、タグ `ai-playtest` / `game:<id>` / `persona:<slug>`、本文は Discord と同じ投稿文 |

| Slack (動画) | 設定 > AI プレイテスト通知「AI プレイテスト動画の Slack チャンネル」(`playtest_notify.slack_channel_id`、schema_meta) と 設定 > Slack の Bot トークン | Slack Bot で `files.getUploadURLExternal` → アップロード → `files.completeUploadExternal` (投稿文を `initial_comment`、`sanitizeSlackMentions`) |

Discord / Slack の配送は [デプロイ反映通知](service-deployed-notify.md) と同じ transport (`deliverDeploymentNotice` / `createDeploymentDelivery`)、
Tabula は [技術相談](tech-consultation.md) §5 と同じ取り込みクライアント (`src/consultation/tabula-client.ts`)。
子会社・プロジェクト別の追加宛先は持たない (本社だけ)。

## 不変条件

- **CC-PLAYTEST-INV-01** 送り手は宛先・URL・Bot token を持たない。宛先は Cc の設定だけが決め、API は秘密を返さない。
- **CC-PLAYTEST-INV-02** 同じ `runId` は 1 回だけ配送する。台帳はこのプロセスの直近 1000 件 (`src/playtest-review/recent-run-ledger.ts`)。
  Ingenium は 1 run で 1 回だけ送り、送り直すのは応答を受け取れなかったときだけなので、再起動を跨ぐ重複までは防がない
  (DB の migration を足さない判断。重複が問題になったら番号付き migration で台帳を DB に移す)。
- **CC-PLAYTEST-INV-03** 良い点と悪い点のどちらかが欠けた感想は受け付けない (400、配送しない)。
- **CC-PLAYTEST-INV-05** Tabula への投稿は設定で有効なときだけ行い、チャットの成否に関係なく同じ投稿文を 1 run 1 ページ (冪等キー) で載せる。
  有効なのに接続先かトークンが無い・取り込みが失敗したときは `tabula: {error}` を返し、チャットの配送は止めない。チャットの宛先が無くても Tabula が有効なら `unconfigured` にしない。
- **CC-PLAYTEST-INV-04** 宛先が 1 つも設定されていなければ配送せず `unconfigured: true` を返す。1 つの宛先の失敗は他を止めず、宛先ごとの `failed` を返す。
  本文 (LLM が書いた文) の mention は配送側で無効化する。
- **CC-PLAYTEST-INV-07** 受け口専用の鍵が設定されているときは、その鍵と定数時間で一致する `x-excubitor-token` だけを通し、本文の検証より先に 401 を返す。
  鍵が読めないときは開けずに断る。未設定のときは従来の判定を変えない。401 のログに鍵・提示値・本文の内容を残さない。

## 動画 (`src/playtest-review/playtest-review-video.ts`)

2026-10-25 指示: 「各周回で動画撮ってバグと感想をその動画にうめこむ。内容のサマリーと合わせてDiscord/Slackに投稿する」。
動画は Ingenium が作る (Ingenium `spec/feature/playtest-review.md` §9)。Cc は受け取った動画を感想と同じ投稿に添付する。

- Discord: 通知チャンネルへ Cc Bot で、投稿文と動画を 1 メッセージ (multipart、`payload_json` + `files[0]`) で出す。
- Slack: incoming webhook はファイルを運べないため、動画のときだけ Slack Bot で動画チャンネルへ上げ、投稿文を最初のコメントにする。
  動画付きで出せた宛先には webhook の投稿文を出さない (同じ感想を 2 回出さない)。
- **CC-PLAYTEST-INV-06** 動画を添付できなかった宛先 (Slack の動画チャンネルか Bot トークンが未設定・添付の失敗) には、投稿文だけを従来の経路で出す。
  感想は動画の成否に関係なく届ける。宛先ごとの添付の成否は応答の `video: {delivered[], failed[]}` に返す (動画なしなら `null`)。

## 投稿文 (`composePlaytestReviewNotice`)

ゲーム名 / 遊び方・画面の種類・判断回数・tick・結果 / 総評 / 👍 良い点 / 👎 悪い点 / ❓ 迷ったところ (あるときだけ) / 🔁 AI の反省 / Voluptas 記録 ID。
2000 文字で切る。

## Muse の結果の中継 (`src/playtest-review/muse-relay.ts`)

2026-11-24 neco 指示「CcのMuseの中継を修正」。Actio `210f7331-0419-4b3e-b0a3-e5e79fe6a7d0`、設計 `spec/plan/2026-11-24-muse-playtest-relay.md`。
Muse は公開経路 `/v1/instructions*` しか持たず、受け口 (`/v1/events/playtest-review`) にも Voluptas にも直接届かない
(Muse の出口は 1 要求に秘密 1 つまで)。そこで Muse の playtest 指令の result を Cc が中継し、LAN 内から Voluptas へ保存して上の告知へ流す。

- 入力: 宛先 `muse`・type `playtest`・status `done` の指令の result の `detail.review` (形は [指令ブリッジ](agent-instructions-bridge.md) の「playtest の結果」)。
  受け口と同じ本文スキーマ (`src/playtest-review/playtest-review-schema.ts`、`voluptasId` だけ除く) で検証する。
  無い・通らない結果は保存も告知もせず、理由を台帳と「muse-指令」の返信に残す (result の受理 202 は変えない)。
- 保存 (`src/playtest-review/voluptas-client.ts`): Voluptas `POST /api/ai-playtests/reviews` へ `Authorization: Bearer <鍵>` と
  `Idempotency-Key: <runId>` で送る。本文は Voluptas の allowlist へ写す (`muse-relay-policy.ts` の `toVoluptasReview`):
  `format=ai-playtest-review/1`・`source=ai-autoplayer`・snake_case・点の `evidence` は `{ticks: [], shots: []}`・
  `created_at` は指令の finishedAt・`engine_version=muse`・`adapter=cc-muse-relay`。201 / 200 の `data.review.id` を記録 ID にする。
- 告知 (`src/playtest-review/announce-playtest-review.ts`): 記録 ID を `voluptasId` に入れ、受け口と同じ use case を内部呼び出しする
  (CDGD 変更列 `ig:playtest-review:<runId>`・Discord / Slack / Tabula・配送の証跡は受け口と同じ)。保存に失敗して確定したときは記録 ID なしで告知する。
- 台帳 `muse_playtest_relays` (migration 157 `src/db/muse-playtest-relays-migration.ts`、`src/db/muse-playtest-relays-repo.ts`): 1 指令 1 行。
  `voluptas_state` `pending|saved|failed|skipped`、`announce_state` `pending|announcing|delivered|failed|skipped`、記録 ID・告知の要約・理由・試行回数・次の試行時刻。
- 再試行: Voluptas の不達・5xx は 1 分から倍にして最大 6 時間間隔で 10 回まで (60 秒ごとの周期で拾う)。4xx は再試行せず `failed`。
  鍵を読めない (復号できない) ときは未設定扱いにせず再試行に回す。
- 見える化: Web の「Muse 指令」の行の詳細に中継の状態 (`GET /v1/instructions/history` の `relay`、`web/src/pages/muse-instructions/RelayStatus.tsx`)。
  「muse-指令」の登録投稿へ「中継: Voluptas 保存 <id> / 告知 <n> 件」を 1 回返す (指令の出来事 `note`)。
- 設定: `services.voluptas_url` (string、`^https?://`)・`services.voluptas_ai_playtest_token` (secret、Voluptas の `VOLUPTAS_AI_PLAYTEST_TOKEN` と同じ値) は
  「兄弟サービス」、`playtest_notify.muse_relay_enabled` (既定 ON) は「AI プレイテスト通知」。秘密は env から読まず DB + 設定画面の 1 系統。
  接続先か鍵が未設定なら保存を `skipped` にして告知だけ行う。
- 結線 (`src/playtest-review/muse-relay-runtime.ts`、`src/bootstrap/core.ts`): 指令ブリッジの `subscribe` で finished を受け、起動時に台帳から再開する。

不変条件:

- **CC-MUSE-RELAY-INV-01** 中継の対象は宛先 muse・type playtest・status done の指令だけ。同じ指令は 1 回だけ台帳に載る (instruction_id 主キー)。
- **CC-MUSE-RELAY-INV-02** `detail.review` は既存の感想スキーマで検証し、通らないものは保存も告知もしない (良い点・悪い点の必須を含む)。
- **CC-MUSE-RELAY-INV-03** Voluptas への保存は runId を冪等キーにし、保存の確定 (saved / skipped / failed) より前に告知しない。
- **CC-MUSE-RELAY-INV-04** 告知は 1 指令 1 回。告知の前に台帳を `announcing` にし、その状態で再起動を跨いだ行は「結果不明」の `failed` にして再送しない。
- **CC-MUSE-RELAY-INV-05** 鍵は設定画面 1 系統で暗号化保存し、API・ログ・台帳・投稿に出さない。Muse の文面は信頼できない入力として告知側と「muse-指令」の mention 無効化を通す。
- **CC-MUSE-RELAY-INV-06** 公開経路は増やさない (`/v1/events/*` は公開しない)。中継は Cc の内部で完結する。

検証: `src/playtest-review/muse-relay.test.ts` (対象外の無視・review 無し / 検証失敗・201 / 200 で記録 ID 付きの 1 回告知・5xx の再試行・4xx の打ち切り・未設定の skipped・
再起動相当の再開で二重告知しない・鍵がログ・台帳・投稿に出ない)。

## 復旧

中継: 設定の鍵を消せば保存を止めて告知だけになる。中継そのものは `playtest_notify.muse_relay_enabled` を OFF にすると止まる。
台帳は表だけなので、消しても指令と Voluptas の記録には影響しない (`failed` の行をやり直したいときは行を消してから Muse に同じ指令を新しく出してもらう)。

投稿が失敗したら、宛先ごとの `failed` が送り手 (Ingenium) の出力に残る。同じ `runId` は Cc が動いている間は受け付けないので、
送り直すときは Ingenium を新しい run で回す。宛先の設定を直せば次の run から届く。
