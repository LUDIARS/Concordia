---
type: feature
title: "Discord の指定チャンネルの発言をサービスへ中継し、サービスの返事を同じ場所へ投稿する"
service: concordia
domain: discord-chat-relay
status: implemented
updated: 2026-10-19
related:
  - ./line-webhook-relay.md
  - ./trust-boundaries.md
---

# Discord チャット中継 (指定チャンネル → サービス → 返信)

Actio タスク: `actio:512e81e3-4744-4cee-a8e2-45b23cdbf0c2`、
`actio:262ba08f-20e5-4125-b2d5-4047a386c060` (お知らせチャンネルの中継と LINE への push)。

[LINE webhook のハブ](./line-webhook-relay.md) と対になる経路。LINE は Cc が webhook を受けてサービスへ
中継し、返事を LINE へ返す。Discord は Cc が既に持っている Discord ゲートウェイ (セッション中継と同じ bot) で
指定チャンネルの発言を拾い、サービスへ中継し、返事を元の発言への reply として投稿する。
サービスは Discord の bot トークンも公開 URL も持たない。

最初の利用者は MemoriaForChild (Mf) の「朝の連絡帳のネタ出し」(neco 指示 2026-10-18「朝の連絡帳のネタ出しを
LINE や Discord でやったら返してくれるようにします」)。Mf 側の受け口 `POST /integrations/discord` は Mf リポの別 PR。

## 価値・シナリオ

- UX-CC-W13 / UX-CC-S14: neco が Discord の家族用チャンネルに「今日の連絡帳なに書こう」と書くと、Cc がその発言を Mf へ
  中継し、Mf の返事が同じチャンネル (スレッドならそのスレッド) に元の発言への返信として出る。サービスを
  足すときは Cc の設定に転送先を 1 行足し、設定画面で中継トークンを 1 つ入れるだけ。

## 値と不変条件

| 値 | 意味 |
|---|---|
| target 名 (`name`) | 転送先の識別子。英小文字・数字・ハイフン (64 文字以内)。ヘッダ `X-Concordia-Discord-Target` に載る |
| channelId | Discord チャンネルの snowflake (数字 17〜20 桁)。1 つの channelId は 1 つの target にだけ属する |
| messageId | Discord の発言の snowflake。転送の冪等キー |
| 中継トークン | サービスが発行し、Cc が `Authorization: Bearer` で送る秘密値 |

- DCR-INV-01: 1 つの channelId は高々 1 つの target に属する。2 つ目の target に同じ channelId を書いた行は
  不採用にして理由を返す (同じ発言を 2 か所へ送らない)。
- DCR-INV-02: セッション中継 (Lictor relay) に割り当て済みのチャンネル (`discord_session_channels` に載っている
  チャンネル・スレッド、およびその親) とは重ならない。重なった発言は中継せずセッション中継に任せ、Cc のログに
  target 名と `session_channel_conflict` だけを残す (同じ発言を二重に処理しない)。
- DCR-INV-03: 同じ messageId は 1 回だけ転送する。転送前に記録し、結果不明 (タイムアウト・接続失敗) でも再送しない。

## 受信

既存の Discord ゲートウェイの `messageCreate` で、次をすべて満たす発言だけを拾う。

- DCR-INV-04: 有効な target の channelIds に入っているチャンネルの発言、またはその子スレッドの発言。
- DCR-INV-05: 人間の発言だけ。bot 自身・他の bot・webhook 発言 (`webhookId` あり)・システムメッセージは除外する。
  本文が空 (添付だけ) の発言は送らない。
- 自 guild 以外 (共有 Client 上の他社イベント) は既存の guild フィルタで先に落ちる。
- 拾った発言は他の ingress (セッション中継・受付・巡回) へは回さない。

## 転送

- DCR-INV-06: `POST <target.url>`、ヘッダは許可リストの次だけ。`Content-Type: application/json`、
  `Authorization: Bearer <中継トークン>`、`X-Concordia-Discord-Target: <target 名>`、`Content-Length`、
  (target に `host` があれば) `Host`。
- 本文 (version 1):

```json
{"version":1,"messageId":"...","channelId":"...","threadId":null,"guildId":"...",
 "author":{"id":"...","displayName":"..."},"text":"...","mentionsBot":false,"sentAt":"2026-10-18T07:00:00.000Z"}
```

  `channelId` は target に登録したチャンネル、`threadId` はスレッド内の発言ならそのスレッド ID (そうでなければ null)。
- DCR-INV-07: タイムアウト 5 秒 (LINE と同じ、接続から応答本文の読み終わりまで)。再送・キューイングはしない。
- 中継トークンが未設定 (復号できない値を含む) の target は転送しない (`relay_token_missing` をログに残す)。
- 転送は LINE と同じ `node:http(s)` の送信器 (`relayLineWebhook`) を使う (Host 上書きを確実に効かせるため)。

## サービスの応答と Discord への投稿

```json
{"replies":[{"text":"..."}]}
```

- DCR-INV-08: サービスが 2xx で、本文が上の形 (replies は 0〜5 件、各 text は 1〜2000 字の文字列) のときだけ、
  各 text を元の発言への reply として順に投稿する (メンションは展開しない)。
- DCR-INV-09: 2xx 以外・タイムアウト・接続失敗・形の違う JSON は投稿しない。Cc のログに target 名と失敗種別
  (`upstream_status` + status / `timeout` / `connect` / `response_too_large` / `invalid_response`) だけを残す。
  本文・発言者名・トークンはログに出さない。

## お知らせチャンネル

関連タスク: `actio:262ba08f-20e5-4125-b2d5-4047a386c060`。
価値は UX-CC-W12/W13。外部 bot の園バス通知を登録したサービスが解釈し、
そのサービスを「ふだんの相手」にした LINE トークへ届けるシナリオ。
Discord の受信・messageId 台帳は discord-chat-relay、トークの紐付けと push 許可は
line-webhook-relay が所有し、中継側は LINE の状態を直接変更しない。
CC-INV-03/06 に従い、送信試行と受理を区別し、結果不明は自動再送しない。
既存台帳はプロセス内・保持期間内の重複抑止であり、再起動を越えた exactly-once は保証しない。

2026-10-22 の引継ぎ時の検証計画 (`augur plan --kind new_feature --base 6c93f270`):
- test-001 正常系: notice の振り分け、文字だけの payload、同名 LINE サービスの既定トークへの push。
  `notice.test.ts` / `chat-relay-surface.test.ts` / `line-webhook/notice-push.test.ts` に対応。
- test-002 消費側契約: 版 1 の chat 互換、notice author、linePush の形、LINE push の HTTP ヘッダと本文。
  契約 dcr-C-6/7/8、line-wh-C-19 とスタブ adapter テストに対応。
- test-003 境界・不正入力: チャンネル重複、人間・自 bot の除外、応答サイズ、未登録・無効・トークなし・
  秘密値なし、429、結果不明時の再送抑止、設定保存と切替を対象とする。
  `targets.test.ts` / `notice.test.ts` / `push.test.ts` / `hub.test.ts` / 設定画面テストに対応。
テスト実行・実 LINE 送信・サービス操作は今回の許可範囲外。実行結果は審査ゲートで確認する。
現行 main への引継ぎでは、既存 LINE push の送信器・UUID 生成・送信許可設定と設定画面を再利用する。
元の worktree は保存し、専用の引継ぎ worktree に差分を適用した。既存 API と notice の許可は同じスイッチで管理する。

neco 指示 (2026-10-19)「おおぞらバスを ForChild の Plugin にして通知を LINE にして欲しい」。園バスの外部サービス
(おおぞらバス) のお知らせは Discord のチャンネルに bot / webhook の投稿として届く。Cc はその投稿をサービス (Mf) へ渡し、
サービスが返した文を LINE のトークへ push する ([LINE webhook のハブ §お知らせの push](./line-webhook-relay.md))。

- DCR-INV-13: target の任意のキー `noticeChannelIds` (snowflake の配列、重複不可) に入っているチャンネル
  (とその子スレッド) では、**bot / webhook の投稿だけ** を拾う。人の発言・システムメッセージ・Cc 自身の bot の投稿は拾わない
  (拾わない投稿は従来の ingress へ流れる)。`channelIds` と同じ ID を両方に置く行、他 target の `channelIds` /
  `noticeChannelIds` と重なる行は不採用にして理由を返す (DCR-INV-01 と同じ)。セッション中継と重なれば中継しない (DCR-INV-02 と同じ)。
- DCR-INV-14: 転送先は target の url (ヘッダは DCR-INV-06 と同じ)。本文は版 1 に `"kind":"notice"` を足したもの。
  人の発言の転送 (kind 省略 = chat) は今までどおり。

```json
{"version":1,"kind":"notice","messageId":"...","channelId":"...","threadId":null,"guildId":"...",
 "author":{"id":"...","displayName":"おおぞらバス","bot":true,"webhookId":"..."},"text":"...",
 "embeds":[{"title":"...","description":"...","fields":[{"name":"...","value":"..."}]}],"sentAt":"2026-10-19T07:00:00.000Z"}
```

  `webhookId` は webhook の投稿のときだけ (bot の投稿なら null)。`embeds` は Discord の埋め込みの文字部分 (title /
  description は無ければ null、fields の name / value) だけで、画像・サムネイル・URL は送らない。本文も埋め込みの文字も
  空の投稿は送らない。冪等 (DCR-INV-03)・5 秒 (DCR-INV-07)・ログに本文を出さない (DCR-INV-09) は同じ。
- DCR-INV-15: notice への応答は `{"replies":[{"text":"..."}],"linePush":[{"text":"..."}]}`。replies は DCR-INV-08 と同じ形で、
  元の投稿への reply として投稿する。`linePush` は省略可、0〜3 件、各 text は 1〜1000 字の文字列。形が違えば投稿も
  push もしない (`invalid_response`)。linePush が 1 件以上あれば target 名と同じ名前の LINE サービスへ push を頼み、
  Cc のログには target 名と push の件数・失敗の status だけを残す。

## 中継トークン

- DCR-INV-10: 置き場所は schema_meta のキー `discord_chat_relay.<target>.relay_token`。LINE の中継トークンと
  同じく AdminState.store (secret-box で暗号化) に置き、env からは読まない。
- DCR-INV-11: 管理 API `/v1/admin/discord-chat-relay` (設定画面 > LINE / Discord 中継) は値を書き込むだけで読み返さない。
  - `GET /targets` → 登録済み target ごとの `{name, enabled, channel_ids, relay_token_set}`。
  - `PUT /targets/:target/secrets/relay_token` (`{"value":"..."}`) で入力・差し替え、`DELETE` で消去。
  - 未登録の target・未知の field は 404、空 / 4096 文字超の値は 400 で保存しない。

## 転送先の登録

設定 `services.discord_chat_relay_targets` (設定画面 > 兄弟サービス、LINE webhook 転送先の隣、schema_meta、秘密値ではない)。
1 行 1 件の JSON オブジェクト `{name, url, host?, channelIds, noticeChannelIds?, enabled}` で書く。

```text
{"name":"mf","url":"http://192.0.2.10:8080/integrations/discord","host":"mf-hook.example.test","channelIds":["123456789012345678"],"noticeChannelIds":["223456789012345678"],"enabled":true}
```

- DCR-INV-12: `name` / `url` / `host` / `enabled` は LINE と同じ形。`channelIds` は 1 件以上の snowflake の配列
  (重複不可)。`noticeChannelIds` は省略可で、snowflake の配列 (重複不可・`channelIds` と重ならない)。
  未知のキー・重複名・他 target と重なる channelId を含む更新は PUT で 400 にして保存しない。
- 受信は発言ごとに設定と秘密値を読むので、保存すると再起動なしで効く。

## 契約

| id | 対象 | 条件 |
|---|---|---|
| dcr-C-1 | `parseDiscordChatRelayTargets` (`src/discord-chat-relay/targets.ts`) | 形式を満たす項目だけを転送先にし、壊れた項目・重複名・他 target と重なる channelId (お知らせのチャンネルを含む) は理由付きで errors に返す |
| dcr-C-2 | `routeDiscordChatMessage` (`src/discord-chat-relay/routing.ts`) | 有効な target のチャンネル (とその子スレッド) の発言だけを中継先に振り、セッション中継のチャンネルと重なれば conflict を返す |
| dcr-C-3 | `buildDiscordRelayHeaders` (`src/discord-chat-relay/relay-headers.ts`) | 転送ヘッダは許可リストだけ |
| dcr-C-4 | `parseDiscordRelayReplies` (`src/discord-chat-relay/replies.ts`) | 取り決めの形のときだけ返事の一覧を返し、それ以外は null |
| dcr-C-5 | `describeDiscordChatRelaySecrets` (`src/discord-chat-relay/secrets.ts`) | 設定済みかどうかの真偽値だけを返す |
| dcr-C-6 | `routeDiscordNotice` (`src/discord-chat-relay/routing.ts`) | 有効な target の noticeChannelIds (とその子スレッド) の投稿だけを中継先に振り、セッション中継と重なれば conflict を返す |
| dcr-C-7 | `isDiscordNoticeAuthor` (`src/discord-chat-relay/notice.ts`) | bot / webhook の投稿で、システムメッセージでも Cc 自身の bot でもないときだけ true |
| dcr-C-8 | `parseDiscordNoticeAnswer` (`src/discord-chat-relay/notice-answer.ts`) | replies (dcr-C-4 の形) と linePush (省略か 0〜3 件・各 1〜1000 字) の形のときだけ返し、それ以外は null |

## 実装の配置

| ファイル | 役割 |
|---|---|
| `src/discord-chat-relay/targets.ts` | 転送先の解釈・検証 (DCR-INV-01, 12) |
| `src/discord-chat-relay/routing.ts` | 発言・お知らせのチャンネル振り分けとセッション中継との重なり判定 (DCR-INV-02, 04, 13) |
| `src/discord-chat-relay/notice.ts` | お知らせの拾い分けと転送本文 (kind: notice) の組み立て (DCR-INV-13, 14) |
| `src/discord-chat-relay/notice-answer.ts` | お知らせへの応答 (replies + linePush) の解釈 (DCR-INV-15) |
| `src/discord-chat-relay/payload.ts` | 転送本文の組み立て (§転送) |
| `src/discord-chat-relay/relay-headers.ts` | 転送ヘッダ (DCR-INV-06) |
| `src/discord-chat-relay/replies.ts` | サービスの応答の解釈 (DCR-INV-08) |
| `src/discord-chat-relay/message-ledger.ts` | messageId の 1 回だけ転送 (DCR-INV-03) |
| `src/discord-chat-relay/secrets.ts` | 中継トークンの読み書きと状態 (DCR-INV-10) |
| `src/discord-chat-relay/relay-service.ts` | 振り分け → 転送 → 応答の検証 → LINE への push の依頼 (DCR-INV-02, 03, 07, 09, 15) |
| `src/discord-chat-relay/runtime.ts` | 設定・中継トークン・LINE への push から中継サービスを組み立てる |
| `src/discord-chat-relay/admin-route.ts` | 中継トークンの管理 API (DCR-INV-11) |
| `src/discord-chat-relay/ontime-runtime.ts` | observe 契約の runtime 再公開 |
| `src/discord/chat-relay-surface.ts` | Discord の発言の判定・転送の依頼・返事の投稿 (DCR-INV-05, 08, 13) |
| `src/discord/chat-relay-notice.ts` | お知らせの投稿の取り出し (埋め込みの文字部分)・転送の依頼・返事の投稿・push 結果のログ (DCR-INV-14, 15) |
| `src/discord/bot.ts` | `messageCreate` で他の ingress より先に中継面へ渡す |
| `src/bootstrap/core.ts` / `src/chat-worker.ts` | 中継サービスを組み立てて bot へ渡す (どちらの構成でも同じ) |
| `src/api/register-core.ts` | 管理 API を `/v1/admin/discord-chat-relay` に登録 |
| `src/config/settings/definitions/platform.ts` | 設定項目 `services.discord_chat_relay_targets` |
| `web/src/pages/settings/sections/DiscordChatRelaySecretsSection.tsx` | 設定画面 > LINE / Discord 中継 (DCR-INV-11) |

## 戻し方

設定 `services.discord_chat_relay_targets` を空にすると、どの発言も中継されず従来の ingress へ流れる。
target の `enabled` を false にするか中継トークンを消すと、その target だけ止まる。
target の `noticeChannelIds` を消すと、お知らせの投稿は拾われず従来の ingress へ流れる (push も止まる)。
LINE への push だけを止めるときは LINE サービスの `pushEnabled` を false にする (お知らせの転送と Discord への返事は続く)。
