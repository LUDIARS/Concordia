---
type: feature
title: "外部エージェント向け HTTP ポーリング指令ブリッジ"
description: "inbound を受けられない外部エージェント (Muse / dots) が Cc に積まれた指令をポーリングで受け取り、ack と結果を返す。公開は Cloudflare Tunnel (このパスは Access を Bypass) + Cc の鍵 1 本 (x-excubitor-token、無ければ Authorization)、登録は loopback のみ。"
service: concordia
domain: agent-instructions
status: implemented
updated: 2026-11-24
tags:
  - muse
  - external-agent
  - cloudflare-tunnel
---

# 外部エージェント向け HTTP ポーリング指令ブリッジ

> 所属ドメイン: [`agent-instructions`](../domains/agent-instructions.domain.json)

2026-11-21 neco 指示「Muse のリンクの実装指示書」(Concordia ⇔ Muse HTTP ポーリング・ブリッジ、Cc 側)。
関連 Actio (Gen5): `bda6872e-de10-4ea6-98dc-a1ac4be92d4d`「Muse へのリレーが動いていない」。

Muse (Meta のパーソナルエージェント) は信頼できないマシン扱いの VM で動き、待ち受けポートも WebSocket の常駐接続も持てない。
そのため push ではなく Muse が外向きに約 5 分間隔でポーリングする。形は [AI プレイテスト感想の投稿](playtest-review-notify.md) (cc-playtest) に揃える:
固定スキーマ、camelCase、新規 202 / 再送 200 `duplicate: true`、ヘッダー `x-excubitor-token` (または `Authorization`) の鍵 1 本。

2026-11-21 neco 決定: 公開経由の認証は CF Access のサービストークン (`CF-Access-Client-Id` / `-Secret` の 2 ヘッダー) をやめ、専用の鍵 1 本にする。
Muse のカスタムコネクタは 1 要求に秘密 1 つまでしか送れないと実測で確定したため (cc-playtest と同じ方式)。

経緯: Access 必須のままサービストークンで通す案 → 2026-11-22 neco 指示「Authorization で進める」でサービストークンを単一ヘッダー
(`read_service_tokens_from_header=Authorization`) で通す案 → 2026-11-23 neco が Cloudflare でこのパスを Bypass にし、認証は Cc の鍵だけに決定。

## 業務用語と状態の所有者

- **指令 (instruction)**: 宛先エージェント 1 つに渡すタスク。所有者は Cc の `agent_instructions` (migration 150)。
- **宛先 (agent)**: 許可リスト `muse` / `dots`。宛先は AI の種類の識別子を兼ね、poll / ack / result は `agent` で名乗る。
  2026-11-23 neco 指示「dotsも同じ路線でやる。AIのタイプ認識用にtypeか何かのパラメータを用意する」で `dots` を追加。
  公開経由の鍵は全宛先で 1 つ (`agent_instructions.intake_token`) を共用する (同日 neco 指示「鍵は1つでいい」)。宛先の取り違えは、
  名乗った `agent` と指令の宛先が違う ack / result を 404 にすることで防ぐ (他の宛先の指令は見えない)。
- **type**: 許可リスト `notify_only` (通知だけ) / `run_task` (タスク依頼) / `status_query` (状態の問い合わせ) / `playtest` ([マージ後の再試遊](merge-playtest-return.md)) / `card_triage` ([管制カードの捌き](control-cards.md)、dots 宛て。2026-11-24 neco 指示で追加)。増やすときは指示書の改訂として扱う。
- **重複判定キー (dedupe_key)**: 指令ごとに 1 つ、登録時に `params.dedupe_key` として確定する (CC-INST-INV-11)。登録者が空でない文字列で入れていればそのまま使い
  (例: マージ後の再試遊の `merge-return:<project>:<merge_commit_sha>`)、無ければ Cc がワンタイムトークン `dk_<32 桁 hex>` を発行する。
  2026-11-23 neco 指示「重複はワンタイムトークンとしてCcが発行しようか」。受け手は 30 分の再配信 (CC-INST-INV-05) で同じ指令が届いても、このキーで二重に実行しない。
- **状態**: `pending` → `acked` → `done` / `failed`。`done` / `failed` は終端。

```
pending --ack--> acked --result--> done / failed
pending --result--> done / failed      (ack 漏れ救済。acked_at も同時に記録)
acked が 30 分 result なし → pending   (sweeper と、ポーリングの直前に戻す)
```

Muse 自身の権限・承認ルールは指令で拡張されない (金銭・送信・削除は Muse 側でユーザ承認)。Cc 側で回避策を作らない。

### cron 由来の指令と Cc による期限切れ終了

[定時ジョブの外部エージェント委託](parttimer-agent-dispatch.md) (2026-11-24) が、loopback の API を通らず use case から直接指令を登録する。

- 登録は `registerOnce`: `params.dedupe_key` (`cron:<job>:<target>:<JST の分>`) が同じ指令が既にあれば登録しない。照合と挿入は同期で続けて行う。
- 期限切れ終了は `closeUnreceived`: `pending` の指令だけを `failed` にする条件付き UPDATE (`markExpired`)。`acked` 以降は外部エージェントが持っているので触らない。`acked_at` は入れない (受け取られなかった事実を残す)。閉じた後の ack / result は CC-INST-INV-03 / 04 のとおり 409。
- 閉じたときも `finished` の出来事を出す (「muse-指令」チャンネルに出る)。detail は `{closed_by:"concordia", fallback:"delegation"}` で、定時ジョブの結果の引き取りはこれを反映しない。
- 前回の所見として、`params.job` が同じ `done` の最新の要約を次の指令の data に入れる (`lastDoneSummary`)。

### type を増やす手順

type は Cc と受け手 (Muse / dots) の取り決めなので、片側だけで増やさない。

**受け手側の書式の置き場所と中身** (Muse は `~/workspace/concordia-bridge/`):
`TASK_FORMAT.md` が全 type 共通の書式 (dedupe_key 必須など)、type ごとに `<TYPE>_SPEC.md` (例: `PLAYTEST_SPEC.md`) を置く。`<TYPE>_SPEC.md` に書くこと:

| 節 | 中身 |
|---|---|
| 見分け方 | どの `type` をこの手順で扱うか。`title` / `body` に頼らず `type` で決める |
| params 表 | 項目名・型・必須か・意味。`dedupe_key` と、対象を一意に決めるキーを必ず含める |
| 手順 | 受け取ったら即 ack → `dedupe_key` で実行済みか確認 (済みなら前回と同じ結果を返して終える) → 実行 → 失敗時の扱い (`failed` で返す条件、途中まで進んだときの後始末) |
| 結果の返し方 | `summary` は 400 字以内で人が読む要約。`detail` の形 (キー名と型) を固定して書く |
| やらないこと | 権限外の操作・承認が要る操作・この type の範囲外の作業 |

記入例は playtest の SPEC (`PLAYTEST_SPEC.md`、[マージ後の再試遊](merge-playtest-return.md))。

**流れ**:

1. Cc: 許可リスト `INSTRUCTION_TYPES` (`src/agent-instructions/instruction-policy.ts`) と本書 (業務用語の type・CC-INST-INV-02) を改訂し、neco の承認を得る。
2. 受け手: `<TYPE>_SPEC.md` を作り、ポーリングの処理に組み込む。
3. テスト指令を 1 件登録し、ack と result が返ること、30 分の再配信や同じ指令の再送で二重に実行されないこと (dedupe_key) を確かめる。
4. 結果を本書の「検証」と受け手側の SPEC に記録する。

**共通の取り決め**:

- type 名は小文字の snake_case。既存の type と意味を重ねない (同じ仕事は params で分ける)。
- 対象を一意に決めるキーを params に入れる (例: 再試遊の `merge_commit_sha`)。登録者が対象から決まる dedupe_key を持てるならそれを入れる。
- 不可逆な操作 (金銭・送信・削除) の承認境界は type を増やしても変わらない。受け手側のユーザ承認を飛ばす type は作らない。
- Muse のジョブは 1 回 1 時間が上限。超えうる type は、続け方 (途中で `done` にして続きを別指令にする・進み具合を `detail` に残すなど) を SPEC に書く。
  Cc は ack から 30 分 result が無いと `pending` に戻して再配信する (CC-INST-INV-05) ので、30 分を超える仕事は再配信を dedupe_key で受け流し、実行中の二重起動をしない。

## 不変条件

| ID | 内容 | 実装 |
|---|---|---|
| CC-INST-INV-01 | 全 POST は固定スキーマ。未知の項目・型違い・文字数 / バイト数超過は 400。エラーは `{error:{code,message}}` で message に直し方を書く | `src/agent-instructions/instruction-requests.ts` |
| CC-INST-INV-02 | 宛先と type は許可リストのみ (`muse`・`dots` / `notify_only`・`run_task`・`status_query`・`playtest`・`card_triage`)。外れたら登録時に 400 | `src/agent-instructions/instruction-policy.ts` |
| CC-INST-INV-03 | ack は `pending` を `acked` にして 202、`acked` への再送は 200 `duplicate: true`、終端は 409、無い ID は 404 | `instruction-policy.ts` `decideAck` |
| CC-INST-INV-04 | result は `pending` / `acked` を終端にして 202 `{delivered:true, failed:false}`。同一結果 (status・要約・詳細。詳細はキー順を無視) の再送は 200 `duplicate: true`、違う結果は 409 | `instruction-policy.ts` `decideResult` |
| CC-INST-INV-05 | `acked` のまま 30 分 result が無い指令は `pending` に戻り再配信される。終端は再配信しない。終端は 90 日で削除 | `instruction-service.ts` / `src/sweeper.ts` |
| CC-INST-INV-06 | 公開経由 (公開ホスト宛て、または Cloudflare Tunnel 由来ヘッダー付き) の poll / ack / result は、鍵の候補 (ヘッダー `x-excubitor-token`、無ければ `Authorization`。`x-excubitor-token` があればそれだけで判定し、値は前後の空白以外加工しない) が専用の鍵 (設定 `agent_instructions.intake_token`) と定数時間比較で一致したものだけ通す。欠落・不一致は本文を読む前に 401 (warn ログに理由だけ、値は出さない)。鍵が未設定・復号できないときは公開経由を全部 401 | `src/agent-instructions/instruction-token.ts` / `public-access.ts` |
| CC-INST-INV-07 | 登録 (`POST /v1/instructions`)・状態確認 (`GET /v1/instructions/:id`)・一覧 (`GET /v1/instructions/history`) は loopback のみ。公開経由は鍵の有無に関係なく 403 (Muse に指令の自己登録をさせない・他の指令を覗かせない) | `src/api/agent-instructions.ts` |
| CC-INST-INV-08 | 指令の出来事 (登録・受領・回答・30 分での再配信) は「muse-指令」チャンネルへ後追い・best-effort で流す。投稿の失敗 (同期の throw も非同期の reject も) は warn ログだけで、登録・ack・result・再配信は失敗させない。受け手が未接続の間の出来事は溜めずに捨てる。「muse-指令」チャンネル (attach) とは別に、管制カードが subscribe で回答 (finished) を受ける (Cc v5、同じく best-effort) | `src/agent-instructions/instruction-events.ts` / `instruction-service.ts` |
| CC-INST-INV-09 | チャンネルへ出す題・本文・回答は信頼できない入力として扱い、mention (`@everyone` / `@here` / `<@…>`) とリンクの自動展開を無効化し、送信側でも `allowedMentions` を空にする。回答の詳細のコードブロックは閉じさせない。鍵・秘密は載せない | `src/agent-instructions/instruction-posts.ts` / `src/discord/muse-instructions-channel.ts` |
| CC-INST-INV-10 | 一覧は Muse 向けの poll と別の口にし、poll の意味 (agent 必須・status 省略時 `pending`・古い順・limit 1〜20) は変えない | `src/agent-instructions/instruction-requests.ts` `parseHistoryQuery` |
| CC-INST-INV-11 | 重複判定キー `params.dedupe_key` は登録時に確定する。登録者が空でない文字列で指定していれば維持し、無ければ Cc がワンタイムトークン (`dk_<32 桁 hex>`) を発行して params に足し、登録応答の `dedupeKey` でも返す。受け手は同じキーの指令を二重に実行しない | `instruction-policy.ts` `withDedupeKey` / `instruction-service.ts` |

## 口 (`src/api/agent-instructions.ts`)

公開ホストの SSO と応答キャッシュより前に登録する (`src/app.ts`)。応答は全部 `cache-control: no-store`。本文の上限 64 KiB (超えたら 413)。

| 口 | 呼ぶ側 | 公開経由 | 成功 |
|---|---|---|---|
| `POST /v1/instructions` | 自宅側 (Web monitor・自宅エージェント・curl) | 403 | 201 `{data:{instruction:{id,status:"pending",createdAt,dedupeKey}}}` |
| `GET /v1/instructions?agent=muse&status=pending&limit=10` | Muse | 鍵が一致したときのみ | 200 `{data:{instructions:[{id,type,title,body,params,createdAt}]}}` (古い順、0 件は空配列) |
| `POST /v1/instructions/:id/ack` | Muse | 鍵が一致したときのみ | 202 / 再送 200 `{duplicate, data:{instruction:{id,status,ackedAt}}}` |
| `POST /v1/instructions/:id/result` | Muse | 鍵が一致したときのみ | 202 / 再送 200 `{delivered:true, failed:false, duplicate, data:{instruction:{id,status,finishedAt}}}` |
| `GET /v1/instructions/history?agent=&status=&limit=50` | 自宅側 (Web の「Muse 指令」) | 403 | 200 `{data:{instructions:[{id,agent,type,title,status,createdAt,ackedAt,finishedAt,resultSummary,body,params,resultDetail}]}}` (新しい順。`agent` / `status` は省略で全部、`limit` 1〜100・省略時 50。範囲外は 400) |
| `GET /v1/instructions/:id` | 自宅側 | 403 | 200 `{data:{instruction:{id,agent,type,title,status,createdAt,ackedAt,finishedAt,resultSummary}}}` |

本文 (strict):

| 口 | 項目 |
|---|---|
| 登録 | `agent` (`muse`)、`type` (許可リスト)、`title` 1〜200 文字、`body` 1〜4000 文字、`params` 省略可 (JSON オブジェクト、8000 バイト以内、省略時 `{}`。`dedupe_key` が無ければ Cc が足す、CC-INST-INV-11) |
| ack | `agent` のみ |
| result | `agent`、`status` (`done` / `failed`)、`summary` 1〜400 文字 (保存は 2000 文字で切り詰め)、`detail` 省略可 (JSON オブジェクト、16000 バイト以内) |

poll の query: `agent` 必須、`status` は 4 状態のどれか (省略時 `pending`)、`limit` は 1〜20 の整数 (省略時 10)。範囲外は 400。

指令 ID: `inst:<agent>:<YYYYMMDDTHHMMSSZ>:<6 桁 hex>`。形が違う ID は 404。時刻は秒精度の ISO 8601 UTC。

## 公開 (Cloudflare Tunnel + 専用の鍵)

Cc は `127.0.0.1` bind のまま。Tunnel の ingress を `https://<公開ホスト>/v1/instructions*` → `http://127.0.0.1:<Cc のポート>` に絞り、
`/v1/sessions` 等は公開しない (ルーティング対象外は Tunnel 側で 404)。公開ホストは `cc-playtest.ai-run-do.com` (`^/v1/instructions(/|$)` を
LOCAL トンネル → Excubitor 入口 `127.0.0.1:17336` → Cc へ。経路は Access 必須にしない: `access_required=false`)。Cloudflare Access は
このパスを Bypass にしてある (cc-playtest のホスト全体の Access アプリは無い)。認証は Cc の鍵だけで行う。Excubitor には Access アプリの
`read_service_tokens_from_header` を設定する口 (Ex PR #4053、ヘッダー名は Authorization のみ) があるが、今の構成では使っていない。
AI プレイテスト受け口 `/v1/events/playtest-review` の公開経路は今は無い (neco 判断で戻さない)。

アプリ側の判定:

- 公開経由か: Host が `CONCORDIA_INSTRUCTIONS_PUBLIC_HOST` に一致するか、`cf-ray` / `cf-connecting-ip` / `cf-access-jwt-assertion`
  のどれかがあれば公開経由 (web-sso の `isPublicRequest` と同じ判定)。公開ホストが未設定・形式不正でもトンネル由来ヘッダーで捕まえる。
- 鍵 (CC-INST-INV-06): `x-excubitor-token` (無ければ `Authorization`) を設定 `agent_instructions.intake_token` と比べる。`Bearer ` などの接頭辞は剥がさない。両辺を SHA-256 にしてから
  `timingSafeEqual` で比べるので、長さの違いも比較時間から漏れない。CF Access の JWT は求めない (あっても鍵の代わりにならない)。
- 鍵は要求ごとに設定から読む。設定画面で差し替えると再起動なしで古い鍵が無効になる。
- Tunnel を迂回して loopback に直接来た要求は local だが、Cc は loopback bind なのでそれはこの PC 上のプロセスに限られる。

| 設定 | 置き場所 | 内容 |
|---|---|---|
| `runtime.instructions_public_host` | env `CONCORDIA_INSTRUCTIONS_PUBLIC_HOST` | 公開ホスト名 (ホスト名だけ)。起動時に読む |
| `agent_instructions.intake_token` | 設定 > 実行環境 (schema_meta、secret-box で暗号化、API は値を返さない) | 公開経由の鍵。Muse と dots で共用の 1 本。値の形は任意 (空白なし 32 文字以上、`^\S{32,}$`)。サービストークンの JSON 1 行である必要はない (今の値がそれでもよい)。AI プレイテスト受け口の鍵 (`playtest_notify.intake_token`) とは別 |

### 人間がやる手順 (Cloudflare・鍵)

1. 鍵の登録: 空白なし 32 文字以上の値を 1 つ用意し、Cc の設定 > 実行環境「指令ブリッジの公開経由の鍵」に保存する。同じ値を Muse と dots のコネクタに
   `x-excubitor-token` (送れなければ `Authorization`) として渡す。値はチャット・ログ・リポジトリに書かない。
2. Access: `cc-playtest.ai-run-do.com` の `/v1/instructions` を Bypass にする (2026-11-23 neco 設定済み)。
3. 公開ルート: `cc-playtest.ai-run-do.com` の `^/v1/instructions(/|$)` → LOCAL トンネル → Excubitor 入口 `127.0.0.1:17336` → Cc (`access_required=false`)。ほかのパスは公開しない。
4. `CONCORDIA_INSTRUCTIONS_PUBLIC_HOST: cc-playtest.ai-run-do.com` は `excubitor.catalog.yaml` の concordia の env に入っている。Excubitor 経由で反映・再起動して読ませる (起動時に読む)。
5. 外から確かめる: 鍵なし 401、鍵ありの poll 200、`POST /v1/instructions` は 403。
6. ローテーション: 鍵を入れ替えたら、Cc の鍵・Muse と dots のコネクタ・Ingenium の設定を同時に直す (どれか 1 つでも古いと 401)。

## 指令チャンネルと Web の画面

2026-11-23 neco 指示「Museへの指令を見れる場所と、回答を記録するチャンネルを用意する」。人が「出した指令」と「回答」を見る場所。どちらも表示だけで、ここから指令は出せない (登録は `POST /v1/instructions`)。

### Discord「muse-指令」チャンネル (`src/discord/muse-instructions-channel.ts`)

- 本社 Bot だけが、本社 guild のトップレベル (カテゴリ外) に用意する。保存済み id (discord config `muse_instructions_channel_id`) → 同名のテキストチャンネル → 無ければ作成、の順で探し、カテゴリに入っていれば外へ出す (バグ報告チャンネルと同じ作り)。子会社 Bot には口を渡さない (子会社の停止で本社の投稿先を外させない)。
- 投稿 (`src/agent-instructions/instruction-posts.ts` の純関数で組み立てる):

| 出来事 | 投稿 |
|---|---|
| 登録 (`POST /v1/instructions` 成功、マージ後の再試遊の自動登録も含む) | 「指令を出しました」id・宛先・type・作成時刻・題・本文の要約 (先頭 300 文字、引用) |
| ack | 登録の投稿への返信で「<宛先> が受け取りました」 |
| result | 登録の投稿への返信で「<宛先> の回答」status (`done` ✅ / `failed` ❌)・題・要約・詳細 (JSON を整形し 1500 文字までのコードブロック) |
| 30 分で `pending` へ戻った | 登録の投稿への返信で 1 行 |
| 補足 (`note`、Muse の試遊結果の中継の状態) | 登録の投稿への返信で 1 行 (「中継: Voluptas 保存 <id> / 告知 <n> 件」) |

- 返信先は登録の投稿 (直近 500 件をメモリで覚える)。覚えていない (Cc の再起動を跨いだ等) ときは同じチャンネルへ id 付きで投稿する。元の投稿が消えていても失敗にしない (`failIfNotExists: false`)。
- 投稿は 1 件 1900 文字以内。失敗は CC-INST-INV-08 のとおり warn だけ。

### Web の「Muse 指令」(`web/src/pages/MuseInstructions.tsx`)

- ナビ「運用」の「Muse 指令」(`/muse-instructions`)。`GET /v1/instructions/history` を 15 秒ごとに読み、表 (宛先・id・種類・題・状態・作成/受領/完了時刻・回答の要約) で出す。宛先 (muse / dots) と状態で絞れる。
- 行を開くと本文・params・回答の要約と詳細。playtest の結果を中継した行は中継の状態 (保存: 記録 ID / 失敗理由、告知: delivered / failed) も出す
  (一覧の各行の `relay`、[AI プレイテスト感想の投稿](playtest-review-notify.md) の「Muse の結果の中継」)。
- 一覧は loopback のみなので、公開ホスト経由で開くと「自宅側からだけ開けます」と出る。

`web/src/pages/MuseInstructions.tsx` / `web/src/pages/muse-instructions/history-api.ts` / `web/src/App.tsx`: 画面・一覧の読み出し・導線。
`src/discord/muse-instructions-channel.ts` / `src/agent-instructions/instruction-posts.ts` / `src/agent-instructions/instruction-events.ts`: チャンネル・投稿文・出来事の中継。

## playtest の結果 (`detail.review`)

type `playtest` の指令に `done` で返す result の `detail` には `review` を入れる。Cc はこれを Voluptas へ保存し、本社の宛先へ告知する
([AI プレイテスト感想の投稿](playtest-review-notify.md) の「Muse の結果の中継」)。`review` が無い・形が違う結果も 202 で受理するが、中継はしない。

```json
{
  "review": {
    "runId": "muse-20261124-001", "gameId": "amicii", "gameTitle": "Amicii", "persona": "casual",
    "outcome": "cleared", "screen": "image", "ticks": 1200, "turns": 40,
    "summary": "総評 (400 文字まで)",
    "good": [{ "aspect": "ux", "text": "良い点 (300 文字まで)" }],
    "bad": [{ "aspect": "game", "text": "悪い点" }],
    "confusions": [],
    "reflection": ["AI の反省 (1〜8 行)"]
  }
}
```

- 項目は `POST /v1/events/playtest-review` の本文と同じ (camelCase、決めた項目だけ)。`voluptasId` は入れない (Cc が保存してから付ける)。
- `good` / `bad` は 1〜8 件必須、`confusions` は 0〜8 件、`aspect` は `ux` / `control` / `game`、`screen` は `image` / `text`、`ticks` / `turns` は 0 以上の整数。
- `runId` は試遊 1 回ごとに一意にする (Voluptas の冪等キー)。`detail` 全体は 16000 バイトまで。

## 復旧

- 結果が分からない ack / result は同じ内容で再送してよい (冪等)。登録は冪等キーを持たないので、`GET` で積まれていないか確かめてから送り直す。
- Muse が ack 後に止まっても 30 分で `pending` に戻り、次のポーリングで再配信される。

## 検証

- `src/api/agent-instructions.test.ts`: 指示書 §6-2〜7 を Hono の要求で再現 (実 DB。公開経由はトンネル由来ヘッダーと鍵の有無で再現)。
- `src/agent-instructions/*.test.ts`: 判定・要求の形・use case・鍵の判定・入口判定・結線。`tests/sweeper.test.ts`: sweeper からの掃除。
- `src/agent-instructions/instruction-events.test.ts`: 出来事の送出と、受け手が throw / reject しても登録・ack・result が成功すること (CC-INST-INV-08)、一覧の並びと絞り込み。
- `instruction-policy.test.ts` / `instruction-service.test.ts` / `src/api/agent-instructions.test.ts`: dedupe_key の維持と発行、登録応答の `dedupeKey` (CC-INST-INV-11)。`src/conflux/merge-return-service.test.ts`: 再試遊の dedupe_key が発行に置き換わらないこと。
- `src/agent-instructions/instruction-posts.test.ts`: 投稿文の組み立てと無害化・上限 (CC-INST-INV-09)。`src/discord/muse-instructions-channel.test.ts`: チャンネルの用意と返信先。
- `src/api/agent-instructions.test.ts`: 一覧が loopback 限定 (公開経由は鍵があっても 403)、poll の互換、dots の poll / ack / result (共用の鍵、宛先違いは 404)。`web/src/pages/MuseInstructions.test.tsx`: 画面。
- `src/scheduler/agent-dispatch.test.ts` / `agent-fallback.test.ts`: cron 由来の `registerOnce` の重複防止と、`closeUnreceived` が pending だけを閉じ、閉じた後の ack / result が 409 になること。
- 未実施: Discord 実機での投稿確認と稼働中 Cc への反映 (再起動が要る。親セッションが行う)。
- 未実施: 公開ホスト経由の実機確認 (§6-6〜8)。公開ルート・Access のサービストークン設定・鍵の生成と稼働中 Cc への反映は人間の許可が要る (上の手順)。
