---
type: feature
title: "Discord の指定チャンネルの発言をサービスへ中継し、サービスの返事を同じ場所へ投稿する"
service: concordia
domain: discord-chat-relay
status: implemented
updated: 2026-10-18
related:
  - ./line-webhook-relay.md
  - ./trust-boundaries.md
---

# Discord チャット中継 (指定チャンネル → サービス → 返信)

Actio タスク: `actio:512e81e3-4744-4cee-a8e2-45b23cdbf0c2`。

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

## 中継トークン

- DCR-INV-10: 置き場所は schema_meta のキー `discord_chat_relay.<target>.relay_token`。LINE の中継トークンと
  同じく AdminState.store (secret-box で暗号化) に置き、env からは読まない。
- DCR-INV-11: 管理 API `/v1/admin/discord-chat-relay` (設定画面 > LINE / Discord 中継) は値を書き込むだけで読み返さない。
  - `GET /targets` → 登録済み target ごとの `{name, enabled, channel_ids, relay_token_set}`。
  - `PUT /targets/:target/secrets/relay_token` (`{"value":"..."}`) で入力・差し替え、`DELETE` で消去。
  - 未登録の target・未知の field は 404、空 / 4096 文字超の値は 400 で保存しない。

## 転送先の登録

設定 `services.discord_chat_relay_targets` (設定画面 > 兄弟サービス、LINE webhook 転送先の隣、schema_meta、秘密値ではない)。
1 行 1 件の JSON オブジェクト `{name, url, host?, channelIds, enabled}` で書く。

```text
{"name":"mf","url":"http://192.0.2.10:8080/integrations/discord","host":"mf-hook.example.test","channelIds":["123456789012345678"],"enabled":true}
```

- DCR-INV-12: `name` / `url` / `host` / `enabled` は LINE と同じ形。`channelIds` は 1 件以上の snowflake の配列
  (重複不可)。未知のキー・重複名・他 target と重なる channelId を含む更新は PUT で 400 にして保存しない。
- 受信は発言ごとに設定と秘密値を読むので、保存すると再起動なしで効く。

## 契約

| id | 対象 | 条件 |
|---|---|---|
| dcr-C-1 | `parseDiscordChatRelayTargets` (`src/discord-chat-relay/targets.ts`) | 形式を満たす項目だけを転送先にし、壊れた項目・重複名・他 target と重なる channelId は理由付きで errors に返す |
| dcr-C-2 | `routeDiscordChatMessage` (`src/discord-chat-relay/routing.ts`) | 有効な target のチャンネル (とその子スレッド) の発言だけを中継先に振り、セッション中継のチャンネルと重なれば conflict を返す |
| dcr-C-3 | `buildDiscordRelayHeaders` (`src/discord-chat-relay/relay-headers.ts`) | 転送ヘッダは許可リストだけ |
| dcr-C-4 | `parseDiscordRelayReplies` (`src/discord-chat-relay/replies.ts`) | 取り決めの形のときだけ返事の一覧を返し、それ以外は null |
| dcr-C-5 | `describeDiscordChatRelaySecrets` (`src/discord-chat-relay/secrets.ts`) | 設定済みかどうかの真偽値だけを返す |

## 実装の配置

| ファイル | 役割 |
|---|---|
| `src/discord-chat-relay/targets.ts` | 転送先の解釈・検証 (DCR-INV-01, 12) |
| `src/discord-chat-relay/routing.ts` | 発言のチャンネル振り分けとセッション中継との重なり判定 (DCR-INV-02, 04) |
| `src/discord-chat-relay/payload.ts` | 転送本文の組み立て (§転送) |
| `src/discord-chat-relay/relay-headers.ts` | 転送ヘッダ (DCR-INV-06) |
| `src/discord-chat-relay/replies.ts` | サービスの応答の解釈 (DCR-INV-08) |
| `src/discord-chat-relay/message-ledger.ts` | messageId の 1 回だけ転送 (DCR-INV-03) |
| `src/discord-chat-relay/secrets.ts` | 中継トークンの読み書きと状態 (DCR-INV-10) |
| `src/discord-chat-relay/relay-service.ts` | 振り分け → 転送 → 応答の検証 → ログ (DCR-INV-02, 03, 07, 09) |
| `src/discord-chat-relay/admin-route.ts` | 中継トークンの管理 API (DCR-INV-11) |
| `src/discord-chat-relay/ontime-runtime.ts` | observe 契約の runtime 再公開 |
| `src/discord/chat-relay-surface.ts` | Discord の発言の判定・転送の依頼・返事の投稿 (DCR-INV-05, 08) |
| `src/discord/bot.ts` | `messageCreate` で他の ingress より先に中継面へ渡す |
| `src/bootstrap/core.ts` / `src/chat-worker.ts` | 中継サービスを組み立てて bot へ渡す (どちらの構成でも同じ) |
| `src/api/register-core.ts` | 管理 API を `/v1/admin/discord-chat-relay` に登録 |
| `src/config/settings/definitions/platform.ts` | 設定項目 `services.discord_chat_relay_targets` |
| `web/src/pages/settings/sections/DiscordChatRelaySecretsSection.tsx` | 設定画面 > LINE / Discord 中継 (DCR-INV-11) |

## 戻し方

設定 `services.discord_chat_relay_targets` を空にすると、どの発言も中継されず従来の ingress へ流れる。
target の `enabled` を false にするか中継トークンを消すと、その target だけ止まる。
