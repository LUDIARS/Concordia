---
type: plan
title: "Muse の試遊結果を Cc が中継し、Voluptas への保存と告知まで行う"
service: concordia
domain: playtest-review-notify
status: draft
related:
  - feature/playtest-review-notify.md
  - feature/merge-playtest-return.md
  - feature/agent-instructions-bridge.md
updated: 2026-11-24
---

# Muse の試遊結果の中継

Actio `210f7331-0419-4b3e-b0a3-e5e79fe6a7d0`。

## 経緯

- 2026-11-24 neco 指示 (原文):「CcのMuseの中継を修正」。添付は Muse の実測報告 `POSTING_FIX_REQUEST_FOR_HQ.md` (要旨は下)。
- Muse は playtest 指令の評価を result で Cc へ返せているが、LUDIARS への投稿の 2 経路が構造的に通っていない。
  - 告知 (`cc-playtest` の `POST /v1/events/playtest-review`): 公開経路は `/v1/instructions*` だけで、鍵の有無に関係なく 404 (Concordia へ届いていない)。
  - 保存 (`vo-playtest` の `POST /api/ai-playtests/reviews`): Muse の出口から TLS 直後に切断され未到達。届いても旧設計 (CF Access の 2 ヘッダ + Voluptas Bearer) は 1 要求に秘密 3 つで、Muse の出口機構が `credential_ambiguity` で必ず拒否する (1 要求に秘密 1 つまで、Muse 側で回避不能)。
- Muse の推奨は案 A「Cc が中継する」。新しい公開経路も追加の秘密も要らない。本計画は案 A を採る (案 B の公開経路の追加は行わない。`/v1/events/playtest-review` の公開経路は今も neco 判断で戻さない)。

## 価値と状態の所有者

- 価値: Muse の試遊の感想が Voluptas (匿名の AI 由来の声) に残り、本社の Discord / Slack / Tabula と CDGD 変更列に流れる (UX-CC-W11 / UX-CC-S12)。
- 指令と結果: 指令ブリッジ `agent_instructions` (Cc)。
- 感想の保存: Voluptas `ai_playtest_reviews` (run_id で一意、`aipt_` ID)。
- 告知: 既存の `handlePlaytestReview` 系 (`src/playtest-review/`) と宛先の設定 (Cc)。
- 中継の進み具合: 新設の中継台帳 (Cc DB)。

## 方式

1. **入力**: 宛先 `muse`・type `playtest` の指令が `done` になったとき、result の `detail.review` を読む。形は Cc の `POST /v1/events/playtest-review` の本文と同じ (camelCase: `runId` / `gameId` / `gameTitle` / `persona` / `outcome` / `screen` / `ticks` / `turns` / `summary` / `good` / `bad` / `confusions` / `reflection`、`voluptasId` は不要)。既存の本文スキーマ (`src/playtest-review/`) でそのまま検証する。`detail.review` が無い・検証に通らない結果は中継せず、理由を台帳と「muse-指令」チャンネルの返信に残す (結果の受理 202 は変えない)。
2. **保存**: Voluptas の `POST /api/ai-playtests/reviews` へ LAN 内から送る。本文は Voluptas の allowlist に写す (`format=ai-playtest-review/1`、`source=ai-autoplayer`、`game_id` 等は snake_case、点の `evidence` は Voluptas の入力検査に合わせる、`created_at` は指令の finishedAt、`engine_version` / `adapter` は Muse を示す固定値)。Voluptas の入力検査 (`player-profile-server/src/services/aiPlaytest/aiPlaytestReviewInput.js`) を読んで必須項目を合わせる。ヘッダは `Authorization: Bearer <鍵>` と `Idempotency-Key: <runId>`。201 / 200 の `review.id` を記録 ID とする。
3. **告知**: 記録 ID を `voluptasId` に入れて既存の告知の use case を内部呼び出しする (HTTP を経由しない)。Discord / Slack / Tabula と CDGD 変更列 (`ig:playtest-review:<runId>`) は既存どおり。
4. **台帳と再試行**: 新設の表 `muse_playtest_relays` (instruction_id 主キー、run_id、voluptas_state `pending|saved|failed|skipped`、voluptas_id、announce_state `pending|delivered|failed|skipped`、announce_result、error、attempts、next_attempt_at、created_at、updated_at)。保存してから外部へ送る。Voluptas の不達・5xx は間隔を空けて再試行 (上限 10 回、最大 6 時間間隔)。保存が確定するまで告知しない。告知は 1 回だけ (Cc 再起動を跨いでも台帳で二重告知しない。結果不明の告知は再送せず `failed` に「結果不明」と残す)。Voluptas の 4xx (入力不正・認証) は再試行せず `failed`。
5. **設定** (秘密は env から読まず DB + 設定画面の 1 系統): `services.voluptas_url` (string、`^https?://`)、`services.voluptas_ai_playtest_token` (secret、Voluptas の `VOLUPTAS_AI_PLAYTEST_TOKEN` と同じ値)。未設定なら保存を `skipped` にして告知だけ行う (従来の voluptasId null と同じ)。値は人間が設定画面で入れる。
6. **見える化**: Web の「Muse 指令」の行の詳細に中継の状態 (保存: 記録 ID / 失敗理由、告知: delivered / failed)。「muse-指令」チャンネルの登録投稿への返信で「中継: Voluptas 保存 <id> / 告知 <n> 件」を 1 回出す。
7. **Muse への手順の伝達**: 反映後に Muse へ `notify_only` で「playtest の result の detail に `review` (上の形) を入れる」と伝える (この PR の範囲外、親セッションが行う)。

## 不変条件

| ID | 内容 |
|---|---|
| CC-MUSE-RELAY-INV-01 | 中継の対象は宛先 muse・type playtest・status done の指令だけ。同じ指令は 1 回だけ台帳に載る |
| CC-MUSE-RELAY-INV-02 | `detail.review` は既存の感想スキーマで検証し、通らないものは保存も告知もしない (良い点・悪い点の必須を含む) |
| CC-MUSE-RELAY-INV-03 | Voluptas への保存は run_id を冪等キーにし、保存の確定より前に告知しない (未設定なら保存を skipped にして告知する) |
| CC-MUSE-RELAY-INV-04 | 告知は 1 指令 1 回。再起動を跨いでも二重告知しない。結果不明の告知は再送しない |
| CC-MUSE-RELAY-INV-05 | 鍵は設定画面 1 系統で暗号化保存し、API・ログ・投稿に出さない。Muse の文面は信頼できない入力として既存の告知側の mention 無効化を通す |
| CC-MUSE-RELAY-INV-06 | 公開経路は増やさない (`/v1/events/*` は公開しない) |

## 実装の置き場所 (DDD)

| 層 | ファイル |
|---|---|
| ドメイン (純関数) | `src/playtest-review/muse-relay-policy.ts` (対象判定・review の取り出しと検証・Voluptas 本文への写像・再試行の要否と間隔) |
| use case | `src/playtest-review/muse-relay.ts` (指令の finished → 台帳 → 保存 → 告知、周期の再試行) |
| adapter | `src/playtest-review/voluptas-client.ts`、`src/db/muse-playtest-relays-repo.ts`、migration (番号は main と未マージのブランチを見て採番。v5 は 156 を使った) |
| 結線 | 指令ブリッジの `subscribe` (v5 で追加) で finished を受ける。bootstrap で周期の再試行を起動 |
| 設定 | `src/config/settings/definitions/platform.ts` に 2 項目 |
| Web | `web/src/pages/MuseInstructions.tsx` の詳細に中継の状態 (読み口は既存の history に `relay` を足すか、別の loopback API) |
| spec | `spec/feature/playtest-review-notify.md` に「Muse の結果の中継」節、`agent-instructions-bridge.md` に playtest の result の `detail.review` の形、`merge-playtest-return.md` に中継への接続 |

テスト: 対象外の指令を無視、review 無し・検証失敗で中継しない、Voluptas 201 / 200 で記録 ID を付けて 1 回告知、Voluptas 5xx で再試行し保存後に告知、4xx は再試行しない、未設定は skipped で告知、再起動相当 (台帳から再開) で二重告知しない、鍵がログに出ない。

## 受入確認 (反映後、人間の許可の範囲で)

Muse に最新の playtest を 1 件返してもらい、Voluptas に記録 (201 / 200、記録 ID あり) ができ、告知が delivered で返ることを Web の「Muse 指令」で確かめる (Muse の受入確認と同じ外形)。

## 復旧

設定の鍵を消せば保存を止めて告知だけになる。中継そのものを止めるには設定 `playtest_notify.muse_relay_enabled` (既定 true) を OFF。台帳は表だけなので、消しても指令と Voluptas の記録には影響しない。
