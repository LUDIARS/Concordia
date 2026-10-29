---
type: feature
title: "LINE の共用チャネルを Cc が持ち、グループ + 言葉でサービスへ振り分けて中継し、返信を代行する"
service: concordia
domain: line-webhook-relay
status: implemented
updated: 2026-10-19
related:
  - ./web-sso.md
  - ./trust-boundaries.md
---

# LINE webhook のハブ (受け口・検証・振り分け・中継・返信)

Actio タスク: `actio:605bbdbf-c384-4d31-9860-6b5d090dbcee` (受け口の新設)、
`actio:54cb27c9-b772-4e8d-baf2-e17d01d95ce3` (チャネルを Cc が持つハブへの作り変え)、
`actio:d444a727-c823-4d10-8922-0b809eb794d8` (共用チャネルとグループ + 言葉の振り分け)、
`actio:ec9d9c8e-83a5-48eb-a926-49efbdf5ee7f` (サービスから LINE のトークへ送る push の口)。

LUDIARS の各サービス (最初は MemoriaForChild = Mf と Memoria = Mm) が LINE 公式アカウントを使う。LINE の
webhook URL をサービスごとに公開せず、Cc の 1 か所で受ける。

neco 決定 (2026-10-18):

- **LINE のチャネルシークレットとチャネルアクセストークンは Cc が持つ。** 署名の検証と LINE への返信は
  Cc が行い、サービスは返事の中身だけを返す。
- **LINE 公式アカウントは 1 つを共用し、Cc がサービスごとの設定で振り分ける。** 振り分けは「グループ + 言葉」:
  呼びかけの言葉があればそのサービス、無ければそのトーク (グループ / トークルーム / 1 対 1) の「ふだんの相手」。
  同じグループに複数サービスがいてよい。

**将来は Conexus へ移す。** いまは置き場所が無いので Cc に置く。受け口・検証・振り分け・中継・返信・秘密値の
管理はこの節と `src/line-webhook/` に閉じており、Cc の他の機能に依存しない (Conexus へ移すときはこのディレクトリと
設定 1 項目・秘密値のキー `line_webhook.channel.*` / `line_webhook.service.*` (push トークンのハッシュと pushEnabled を含む)・テーブル `line_talk_links` を持っていけばよい)。

## 価値・シナリオ

- UX-CC-W12 / UX-CC-S13: neco が LINE Developers の webhook URL に `https://<公開ホスト>/hooks/line/<channel>` を
  設定し、検証ボタンを押すと Cc が署名を検証する。グループで「つなぐ <コード>」と送るとサービスがそのグループに
  つながり、以後は呼びかけの言葉で始まる発言はそのサービスへ、言葉の無い発言はふだんの相手へ届く。
  サービスを足すときは Cc の設定にサービスを 1 行足し、設定画面で中継トークンを入れるだけで、サービス側に
  公開 URL も LINE の秘密値も要らない。

## 流れ

1. LINE → `POST https://<公開ホスト>/hooks/line/:channel` (Cc)。
2. Cc はチャネルシークレットで `X-Line-Signature` を検証する (§署名の検証)。
3. Cc はイベントを振り分け (§振り分け)、回し先 (サービス × トーク) ごとに本文を作り直す。
4. Cc → サービス: `POST <service.url>` に本文と中継トークンを付けて並行に送る (§転送)。
5. サービス → Cc: `{"replies":[...], "linked"?: true, "unlinked"?: true}` を返す (§サービスの応答と LINE への返信)。
6. Cc は紐付けを記録し、LINE へ応答を返し、replies を postback を包んで合流してから LINE reply API へ送る。

## 受け口

`POST /hooks/line/:channel` (`:channel` はサービスの登録に現れるチャネル名。英小文字・数字・ハイフン)。

- LINE-WH-INV-01: Cc の認証 (公開ホストの Web SSO / CF Access) を掛けない唯一の経路。`buildApp` は
  この経路を SSO と応答キャッシュのミドルウェアより前に登録し、ここで応答を返して後続へ進めない。
  他の経路 (管理 API を含む) は今まで通り認証を要求する。
- LINE-WH-INV-02: POST 以外のメソッド・enabled のサービスが 1 つも無いチャネル・名前形式違反・入れ子のパスは 404
  (認証画面や Web 画面の fallback へ落とさない)。
- LINE-WH-INV-03: 署名は受けたままのバイト列で検証する。上限 1 MB、超えたら 413。署名の通った本文が JSON で
  `events` 配列を持たなければ 400 `{"error":"invalid_body"}`。
- LINE-WH-INV-04: 応答キャッシュを通さない (`cache-control: no-store`)。ログ・応答に秘密値・本文・署名・
  replyToken・メッセージを出さない (チャネル・サービス名・status・所要時間・本文バイト数・件数だけ)。
- LINE-WH-INV-07: LINE への応答は、回し先が 1 つ以上あり 1 つ以上が成功 (2xx で応答の形が正しい) なら 200 `{}`、
  回し先が全部失敗なら 502 `{"error":"upstream_failed"}`、回し先が 0 (誰にも回さない) なら 200 `{}`。
  失敗は 2xx 以外・タイムアウト (5 秒)・接続失敗・応答の形違い・中継トークン未設定。

## 署名の検証

- LINE-WH-INV-09: `X-Line-Signature` は受けた本文バイト列の、チャネルシークレットによる
  HMAC-SHA256 の base64。一致しなければ 401 `{"error":"signature_rejected"}` で、サービスへは送らない。
- LINE-WH-INV-10: チャネルシークレットが未設定 (復号できない値を含む) なら
  503 `{"error":"line_channel_not_configured"}` で、サービスへは送らない。

## 振り分け

Cc が行う (サービスはしない)。対象はそのチャネルの enabled のサービス (設定順)。イベントのトークは
`source` の groupId → roomId → userId の順で決める (どれも無いイベントは回さない)。

- LINE-WH-INV-14: text のメッセージイベントは、本文からボットへのメンション部分 (`mention.mentionees` の
  `isSelf: true`) と先頭の空白を除いた文で判定する。
  - その文がいずれかのサービスの呼びかけの言葉で始まる → そのサービスだけ。言葉が複数のサービスに当たるときは
    長い言葉を優先し、同じ長さなら設定順で先。
  - 言葉が無い → そのトークの「ふだんの相手」だけ。ふだんの相手が無いトークは誰にも回さない。
  - 「つなぐ <コード>」(「つなぐ」の後に全角・半角の空白と数字だけ、数字 1 つ以上) → 全サービスに回す。
- LINE-WH-INV-15: 「つなぐ」を回した本文に、サービスが `"linked": true` を返したら、そのトークにそのサービスを
  つないだと Cc が記録する。そのトークにふだんの相手がまだ無ければ、それをふだんの相手にする
  (同じ本文で複数サービスがつながったときは設定順で先のもの)。`"unlinked": true` ならそのトークとの紐付けを消す。
- LINE-WH-INV-16: postback は data が `cc:<サービス名>:<元の data>` のときだけ、包みを外してそのサービスへ回す
  (そのサービスがそのチャネルの enabled のサービスでなければ回さない)。包みの無い postback は回さない。
- LINE-WH-INV-17: leave (ボットがグループから抜けた) はそのトークにつながっていた全サービスへ回し、
  回した後でそのトークの Cc の記録をすべて消す。memberLeft / memberJoined もつながっている全サービスへ回す。
  follow / join は全サービスへ回す (挨拶)。
- その他のイベント (画像・スタンプ等の text 以外のメッセージ、unfollow 等) はそのトークのふだんの相手へ回す
  (無ければ回さない)。

## 転送

- LINE-WH-INV-05: 回し先 (サービス × トーク) ごとに、LINE の webhook 本文と同じ形
  `{"destination": <受けた destination>, "events": [そのサービスに回すと決まった、そのトークのイベント]}` を作り直して送る
  (1 本文 = 1 トーク。応答の linked / unlinked がそのトークを指せるように)。postback は包みを外した data にする。
  本文を作り直すので、サービスは LINE の署名を見ない。ヘッダは次だけ (許可リスト方式):
  `Content-Type: application/json`、`Authorization: Bearer <サービスの中継トークン>`、
  `X-Concordia-Line-Target: <サービス名>`、`X-Concordia-Line-Channel: <チャネル名>`、`Content-Length`。
  `X-Line-Signature`・`cf-*`・`x-forwarded-*`・`Cookie` は送らない。
- LINE-WH-INV-06: サービスに `host` があれば Host ヘッダをそれにする (MemoriaForChild は連携専用
  ホスト名の Host で来た `/integrations/` だけを Access 免除にしているため)。無ければ URL のホスト。
- 回し先への転送は並行、それぞれタイムアウト 5 秒。中継トークンが未設定のサービスへは送らない (その回し先は失敗)。
- 再送・キューイングはしない (LINE 側の再送に任せる)。転送は `node:http(s)` で送る (fetch は Host を禁止ヘッダとして扱う実装があるため)。

## サービスの応答と LINE への返信

サービスは中継トークンが合えば 200 と次の本文を返す (返事が無ければ `{"replies":[]}`)。

```json
{"replies":[{"replyToken":"<イベントの replyToken>","messages":[{"type":"text","text":"..."}]}],"linked":true}
```

`linked` は「つなぐ」が成功したときだけ、`unlinked` はサービス側でトークとの紐付けを消したとき。どちらも省略可。

サービス側の取り決め: 中継トークン未発行 → 503 `{"error":"integration_not_configured"}`、
不一致・欠落 → 401 `{"error":"relay_token_rejected"}`、本文不正 → 400。自分に回ってきたイベントにだけ答え、
言葉が無い発言が回ってきたら (自分がふだんの相手) 自分の流儀で答えてよい。つながっていないトークの発言には
「つなぐ」の案内を返す。グループ内でのメンション判定はしない (Cc が振り分けるため)。

- LINE-WH-INV-11: 成功した回し先の replies を LINE reply API (`POST https://api.line.me/v2/bot/message/reply`、
  `Authorization: Bearer <チャネルアクセストークン>`、本文 `{replyToken, messages}`) へ送る。LINE への応答を
  返した後に送る。返信の失敗 (チャネルアクセストークン未設定を含む) はログ (チャネルと status だけ) に残し、
  LINE への応答は変えない。messages の中身は postback の包み以外は解釈せずそのまま渡す。
- reply API の呼び出しは受け口の依存 (`sendReply`) として差し替えられ、テストでは実 LINE を呼ばない。
  URL はコード定数 `LINE_REPLY_API_URL` (送信器の生成時に差し替えられる)。

### postback

- LINE-WH-INV-18: 返信の messages に含まれる postback アクション (`type` が `postback` / `datetimepicker` で
  `data` を持つもの。テンプレート・クイックリプライ・Flex の中も含む) の data を `cc:<サービス名>:<元の data>` に
  包んで LINE へ送る。包むと LINE の data 上限 300 文字を超える data が 1 つでもあれば、その返信は包まずに
  そのまま送り (捨てない)、ログに残す (その postback は押されても回らない)。

### 返信の合流

- LINE-WH-INV-19: 同じ replyToken への返信 (follow / join を全サービスへ回したとき等) は、設定順に messages を
  連結して 1 件にする。reply API の上限 5 件を超えた分は捨て、捨てた件数をログに残す。

## LINE push の受け口

サービスが自分の都合で (LINE からの発言を待たずに) トークへ知らせるための口。サービスは LINE の秘密値を
持たないので、Cc に「このサービスのトークへ送って」と頼む。

`POST /hooks/line/:channel/push/:service` (webhook の受け口と同じリスナー・同じ公開経路 `^/hooks/line/`)。

```json
{"requestId":"<呼び出し側が決める一意の文字列>","messages":[{"text":"..."}]}
```

- LINE-WH-INV-21: 経路と認証。SSO と応答キャッシュを通さない (LINE-WH-INV-01 と同じ扱い、`cache-control: no-store`)。
  `:service` がそのチャネルの enabled のサービスでなければ 404 (POST 以外のメソッドも 404)。
  認証はサービスごとの **push トークン** (中継トークンとは別物) を `Authorization: Bearer <push トークン>` で送る。
  Cc はトークンの SHA-256 だけを持ち、定数時間で照合する。未発行 503 `{"error":"push_token_not_configured"}`、
  不一致・欠落 401 `{"error":"push_token_rejected"}`。
- LINE-WH-INV-22: サービスごとの `pushEnabled` (既定 false)。false なら認証の後で 403 `{"error":"push_disabled"}` を返して送らない。
- LINE-WH-INV-23: 本文は `requestId` (空白・制御文字を含まない 1〜64 文字) と `messages` (text だけを持つ 1〜3 件、
  各 text は 1〜1000 文字) だけ。形違い・未知のキーは 400 `{"error":"invalid_body"}`、64 KB を超える本文は 413。
- LINE-WH-INV-24: 送り先はそのチャネルで、そのサービスを「ふだんの相手」にしているトーク (LINE-WH-INV-15 の記録)
  すべて。無ければ送らずに 200 `{"sent":0,"failed":0}`。呼びかけの言葉でだけ呼ばれるトークへは送らない。
- LINE-WH-INV-25: LINE への送信は push API (`POST https://api.line.me/v2/bot/message/push`、チャネルアクセストークン、
  本文 `{to, messages:[{type:"text",text}]}`) をトークごとに並行で呼ぶ。`X-Line-Retry-Key` は
  (channel, service, requestId, トーク) から決まる UUID (同じ requestId の再送で LINE 側でも二重送信にならない。
  LINE が受理済みのキーに返す 409 は送れている扱い)。チャネルアクセストークン未設定は 503
  `{"error":"line_channel_not_configured"}`。再送はしない (LINE の 429 = 月間上限なども failed に数える)。
- LINE-WH-INV-26: Cc は requestId を (channel, service) ごとに 24 時間覚え、同じ requestId は送らずに前回の結果を返す
  (送信中の同じ requestId は同じ送信を待つ)。記憶はプロセス内のメモリで、再起動で忘れても LINE 側の Retry-Key で
  二重送信にならない。
- LINE-WH-INV-27: 1 サービスあたり 1 分 10 件まで。超えたら 429 `{"error":"rate_limited"}` で送らない
  (同じ requestId の再送は前回の結果を返すので枠を使わない)。
- 応答は 200 `{"sent":<送れたトーク数>,"failed":<失敗したトーク数>}`。ログはチャネル・サービス名・status・件数・
  所要時間と LINE の失敗 status だけ (本文・requestId・宛先 ID・トークンを出さない)。
- LINE push API の呼び出しは受け口の依存 (`sendPush`) として差し替えられ、テストでは実 LINE を呼ばない。
  URL はコード定数 `LINE_PUSH_API_URL`。

## 秘密値

| キー | 用途 | 出所 |
|---|---|---|
| `line_webhook.channel.<channel>.channel_secret` | 署名の検証 | LINE Developers のチャネル基本設定 |
| `line_webhook.channel.<channel>.channel_access_token` | LINE reply API の呼び出し | LINE Developers の Messaging API 設定 (長期トークン) |
| `line_webhook.service.<service>.relay_token` | サービスへの転送の `Authorization` | サービス側が発行し、平文を発行時に 1 度だけ画面に出す。人間がその値を貼る |
| `line_webhook.service.<service>.push_token_sha256` | push の口の認証 (SHA-256 の hex だけ) | Cc が作り、平文は発行の応答で 1 度だけ画面に出す。人間がサービス側に貼る |
| `line_webhook.service.<service>.push_enabled` | push の口を開けるか (`"true"` のときだけ有効、無ければ無効) | 設定画面の切替 |

- LINE-WH-INV-12: 置き場所は schema_meta。AdminState.store が secret-box で暗号化して保存するので、
  二重に暗号化しない。サービスは中継トークンのハッシュだけを持つ。共用チャネル導入前の旧キー
  `line_webhook.<target>.*` は値が未登録だったので移行しない。
- 実際の値の登録は親セッションが反映後に行う。

## サービスの登録

設定 `services.line_webhook_targets` (設定画面 > 兄弟サービス、schema_meta、秘密値ではない)。
1 行 1 件の JSON オブジェクト `{name, url, host?, enabled, channel?, keywords?}` で書く。

```text
{"name":"mf","url":"http://192.0.2.10:8080/integrations/line/webhook","host":"mf-hook.example.test","enabled":true,"channel":"ludiars","keywords":["おてつだい"]}
{"name":"mm","url":"http://192.0.2.11:5180/integrations/line/webhook","enabled":true,"channel":"ludiars","keywords":["メモリア"]}
```

- LINE-WH-INV-08: `name` / `channel` は英小文字・数字・ハイフン (64 文字以内)、`url` は http / https (資格情報入り
  不可)、`host` はホスト名 (任意で `:ポート`)、`enabled` は真偽値、`keywords` は 1〜32 文字の文字列の配列
  (20 個まで・重複不可、前後の空白は落とす)。`channel` の無い行は自分の name をチャネル名とみなす
  (共用チャネル導入前の `mf` 行がそのまま読める)。未知のキー・重複名を含む更新は PUT で 400 にして保存しない。
- 受け口は要求ごとに設定と秘密値を読むので、保存すると再起動なしで効く。

## トークごとの紐付け

テーブル `line_talk_links` (migration 144): `channel`・`talk_id` (groupId / roomId / userId)・`service`・
`is_default` (ふだんの相手か)・`linked_at` (つないだ時刻)。`(channel, talk_id, service)` は一意で、
トークごとにふだんの相手は高々 1 つ。

## 管理 API と設定画面

`/v1/admin/line-webhook` (設定画面 > LINE webhook)。秘密値は書き込むだけで読み返さない。

- LINE-WH-INV-13: 秘密値。
  - `GET /channels` → チャネルごとの `{name, webhook_path, services, channel_secret_set, channel_access_token_set}`
    (`webhook_path` は `/hooks/line/<channel>`)。
  - `PUT /channels/:channel/secrets/:field` (`field` は `channel_secret` / `channel_access_token`、本文 `{"value":"..."}`)
    で入力・差し替え、`DELETE` で消去。
  - `GET /services` → サービスごとの `{name, channel, enabled, keywords, relay_token_set, push_token_set, push_enabled}`。
  - `PUT /services/:service/relay-token` (`{"value":"..."}`) で入力・差し替え、`DELETE` で消去。
  - push トークン (LINE-WH-INV-21): `POST /services/:service/push-token` で発行・発行し直し (応答の `push_token` に
    平文を 1 度だけ入れる。前のトークンは効かなくなる)、`DELETE` で消去。`PUT /services/:service/push-enabled`
    (`{"enabled":true|false}`、真偽値以外は 400) で切り替える。`GET /services` は `push_token_set` と `push_enabled` を足して返す。
  - 応答は設定済みかどうかだけ。未登録のチャネル / サービス・未知の field は 404、空 / 4096 文字超の値は 400 で保存しない。
- LINE-WH-INV-20: 呼びかけの言葉と紐付け。
  - `PUT /services/:service/keywords` (`{"keywords":[...]}`) は設定 `services.line_webhook_targets` のそのサービスの
    行の `keywords` だけを書き換える (他の行・キーはそのまま)。形が違えば 400、設定が読めなければ 409 で保存しない。
  - `GET /links` → `{id, channel, talk_kind, talk_id_prefix, service, is_default, linked_at}` の一覧。
    トーク ID は先頭 5 文字だけを返す (全体は LINE のユーザー / グループを特定できるので出さない)。
  - `PUT /links/:id/default` でそのトークのふだんの相手をそのサービスに変え、`DELETE /links/:id` で紐付けを解除する。
    無い id は 404。

## 公開ホスト

公開ホスト名は親セッションが Excubitor の CF ブローカーで用意する (Tunnel 側でもパス `^/hooks/line/`
だけを通す)。

## 契約

| id | 対象 | 条件 |
|---|---|---|
| line-wh-C-1 | `parseLineWebhookTargets` (`src/line-webhook/targets.ts`) | 形式を満たす項目だけをサービスにし、壊れた項目・重複名は理由付きで errors に返す |
| line-wh-C-2 | `channelServices` (`src/line-webhook/targets.ts`) | そのチャネルの enabled のサービスだけを設定順に返す |
| line-wh-C-3 | `buildRelayHeaders` (`src/line-webhook/relay-headers.ts`) | 転送ヘッダは許可リストの 6 本だけで、X-Line-Signature を含まない |
| line-wh-C-4 | `verifyLineSignature` (`src/line-webhook/signature.ts`) | 本文バイト列の HMAC-SHA256 base64 と一致するときだけ true |
| line-wh-C-5 | `parseServiceReplies` (`src/line-webhook/replies.ts`) | 取り決めの形のときだけ返信の一覧を返し、それ以外は null |
| line-wh-C-6 | `describeLineChannelSecrets` (`src/line-webhook/channel-secrets.ts`) | 設定済みかどうかの真偽値だけを返す |
| line-wh-C-7 | `matchServiceKeyword` (`src/line-webhook/routing-text.ts`) | 長い言葉優先・同じ長さなら設定順で、呼びかけの言葉で始まるサービスを返す |
| line-wh-C-8 | `isLinkCommand` (`src/line-webhook/routing-text.ts`) | 「つなぐ」+ 空白と数字だけのときだけ true |
| line-wh-C-9 | `routeLineEvents` (`src/line-webhook/routing.ts`) | 回し先は 1 サービス × 1 トークで重複せず、イベントはすべてそのトークのもの |
| line-wh-C-10 | `wrapReplyPostbacks` (`src/line-webhook/postback.ts`) | data をすべて `cc:<サービス>:` で包み 300 文字以下、超えるなら元のまま |
| line-wh-C-11 | `unwrapPostbackData` (`src/line-webhook/postback.ts`) | 包みのあるときだけ外し、包み直すと入力に戻る |
| line-wh-C-12 | `mergeReplies` (`src/line-webhook/merge-replies.ts`) | replyToken は重複せず、messages は 1〜5 件 |
| line-wh-C-13 | `parseServiceAnswer` (`src/line-webhook/replies.ts`) | 取り決めの形のときだけ replies と linked / unlinked を返す |
| line-wh-C-14 | `parsePushRequest` (`src/line-webhook/push-request.ts`) | requestId と text だけの 1〜3 件のときだけ {requestId, texts} を返す |
| line-wh-C-15 | `matchPushToken` (`src/line-webhook/push-token.ts`) | Bearer のトークンの SHA-256 が保存したハッシュと一致するときだけ true |
| line-wh-C-16 | `selectPushTalks` (`src/line-webhook/push-recipients.ts`) | そのサービスがふだんの相手のトークだけを重複なく返す |
| line-wh-C-17 | `derivePushRetryKey` (`src/line-webhook/push-retry-key.ts`) | UUID の形で、同じ 4 つ組からは同じ値 |
| line-wh-C-18 | `takePushSlot` (`src/line-webhook/push-limits.ts`) | 直近 1 分 10 件未満のときだけ枠を取る |

## 実装の配置

| ファイル | 役割 |
|---|---|
| `src/line-webhook/targets.ts` | サービスの解釈・検証・チャネルごとの解決・呼びかけの言葉の書き換え (LINE-WH-INV-02, 08) |
| `src/line-webhook/signature.ts` | 署名の検証 (LINE-WH-INV-09) |
| `src/line-webhook/routing-text.ts` | メンション除去・呼びかけの言葉・「つなぐ」の判定 (LINE-WH-INV-14) |
| `src/line-webhook/routing.ts` | イベントの振り分け (LINE-WH-INV-14〜17) |
| `src/line-webhook/postback.ts` | postback の包みと外し (LINE-WH-INV-16, 18) |
| `src/line-webhook/merge-replies.ts` | 返信の合流 (LINE-WH-INV-19) |
| `src/line-webhook/talk-links.ts` | トークごとの紐付けの記録 (SQLite / メモリ) (LINE-WH-INV-15, 17) |
| `src/line-webhook/dispatch.ts` | 回し先ごとの本文の作り直し・並行転送・応答の回収・紐付けの反映 (LINE-WH-INV-05, 07, 15) |
| `src/line-webhook/relay-headers.ts` | 転送ヘッダと Host 上書き (LINE-WH-INV-05, 06) |
| `src/line-webhook/relay.ts` | 転送先への POST とタイムアウト (LINE-WH-INV-07) |
| `src/line-webhook/replies.ts` | サービスの応答本文の解釈 (LINE-WH-INV-07, 15) |
| `src/line-webhook/reply-client.ts` | LINE reply API の呼び出し (LINE-WH-INV-11) |
| `src/line-webhook/channel-secrets.ts` | チャネル・サービスの秘密値の読み書きと状態 (LINE-WH-INV-10, 12) |
| `src/line-webhook/admin-route.ts` | 管理 API (LINE-WH-INV-13, 20) |
| `src/line-webhook/route.ts` | 受け口・本文上限・検証・振り分け・応答・返信・ログ (LINE-WH-INV-01〜04, 07, 09〜11, 17〜19)。push の口の登録 |
| `src/line-webhook/http.ts` | 受け口と push の口が共有する JSON 応答・本文の上限読み・ログの型 (LINE-WH-INV-03, 04) |
| `src/line-webhook/push-route.ts` | push の口: 判定の順・送信・結果の記憶・ログ (LINE-WH-INV-21〜27) |
| `src/line-webhook/push-request.ts` | push の本文の検証 (LINE-WH-INV-23) |
| `src/line-webhook/push-token.ts` | push トークンの発行・ハッシュ・定数時間の照合と pushEnabled の読み書き (LINE-WH-INV-21, 22) |
| `src/line-webhook/push-recipients.ts` | push の送り先の決定 (LINE-WH-INV-24) |
| `src/line-webhook/push-retry-key.ts` | `X-Line-Retry-Key` の導出 (LINE-WH-INV-25) |
| `src/line-webhook/push-limits.ts` | 1 分 10 件の上限と requestId の 24 時間の記憶 (LINE-WH-INV-26, 27) |
| `src/line-webhook/push-client.ts` | LINE push API の呼び出し (LINE-WH-INV-25) |
| `src/line-webhook/ontime-runtime.ts` | observe 契約の runtime 再公開 |
| `src/db/schema.ts` / `src/db/migration-ledger.ts` | migration 144 `line_talk_links` と凍結台帳 |
| `src/app.ts` | SSO・応答キャッシュより前に受け口を登録 (LINE-WH-INV-01) |
| `src/api/register-core.ts` | 管理 API を `/v1/admin/line-webhook` に登録 (LINE-WH-INV-13, 20) |
| `src/bootstrap/core.ts` | 受け口と管理 API へサービス・秘密値 (AdminState.store)・紐付け (SQLite) を渡す |
| `src/config/settings/definitions/platform.ts` | 設定項目 `services.line_webhook_targets` |
| `web/src/api.ts` | 管理 API の呼び出しと型 (LINE-WH-INV-13, 20) |
| `web/src/pages/settings/sections/LineWebhookSecretsSection.tsx` | 設定画面 > LINE webhook (チャネル・サービス) (LINE-WH-INV-13, 20) |
| `web/src/pages/settings/sections/useLineWebhookAdmin.ts` | 設定画面の一覧の読み込みと各操作 (消去・解除の確認を含む) (LINE-WH-INV-13, 20) |
| `web/src/pages/settings/sections/LineSecretField.tsx` | 秘密値 1 項目の行 (設定済みかどうか・入力・差し替え・消去、値を画面に残さない) (LINE-WH-INV-13) |
| `web/src/pages/settings/sections/LineKeywordsField.tsx` | サービスの呼びかけの言葉の行 (LINE-WH-INV-20) |
| `web/src/pages/settings/sections/LinePushField.tsx` | サービスの push トークン (発行 / 発行し直す / 消す、発行直後だけ平文を表示) と LINE への送信の切替の行 (LINE-WH-INV-21, 22) |
| `web/src/pages/settings/sections/LineTalkLinksPanel.tsx` | 設定画面 > LINE webhook (トークごとの紐付け) (LINE-WH-INV-20) |

## 戻し方

設定 `services.line_webhook_targets` を空にすると受け口はすべて 404 になる。チャネルシークレットを消すと
そのチャネルは 503 になる。サービスの中継トークンを消すとそのサービスへは回らない (回し先が全部それなら 502)。
公開ホスト側の `^/hooks/line/` を外せば外からは届かない。
push の口は、設定画面で「LINE への送信」を無効にすると 403 で止まり (トークンは残る)、push トークンを消すと 503 になる
(サービス側のトークンも効かなくなるので、再開するときは発行し直してサービス側に貼り直す)。発行し直すと前のトークンは 401。migration 144 のテーブルは消さずに残してよい
(受け口が使わなくなるだけ)。

## お知らせの push

関連タスク: `actio:262ba08f-20e5-4125-b2d5-4047a386c060`。UX-CC-W12/W13、CC-INV-03/06。
Discord の登録済み notice チャンネルの外部 bot / webhook 投稿をサービスが解釈し、返した linePush を届ける。
LINE の紐付けと送信許可は line-webhook-relay が所有し、中継側は状態を書き換えない。

- LINE-WH-INV-28: Discord target と同名で enabled の LINE サービスのチャネルから、そのサービスを
  ふだんの相手にしているトークだけを重複なく選ぶ。未登録・無効・push 不許可では送らない。トークなしは件数 0。
- LINE-WH-INV-29: 既存 createLinePushSender を使い、トークごとに 1 回、検証済みの 1〜3 件の text を push。
  チャネルアクセストークン、5 秒期限、409 を受理済みとして扱う点は既存 API と共通。
  retry key は derivePushRetryKey(channel, service, `discord-notice:<messageId>`, index) により生成する。
  notice の名前空間と宛先番号を用い、既存の外部 push の requestId / 実トーク ID の組と分離する。
- LINE-WH-INV-30: 既存のサービス別 pushEnabled (既定 false、保存キー `line_webhook.service.<service>.push_enabled`)
  と設定画面の「LINE への送信」を共用する。設定は通知ごとに読み、停止は次の通知から効く。
  別のスイッチや target JSON の同名キーは追加しない。通知経路は Cc 内部のためサービス用 push トークンは不要。
  429・結果不明も再送せず、ログには件数と失敗 status のみ。本文・宛先 ID・秘密値を出さない。

契約: `C-19 resolveLinePushTalks(targets, links, service): 有効で push 許可のあるサービスの既定トークだけを返す`。
`augur.contracts.json` の id は line-wh-C-19。既存の line-wh-C-14〜18 は変更しない。
src/line-webhook/push-talks.ts (純粋な宛先判断)、notice-push.ts (配送手順)、notice-push.test.ts
(純関数・スタブ送信器のテスト) に分離する。設定の読取は discord-chat-relay/runtime.ts が組み立てる。
復旧は noticeChannelIds を消すか、既存の「LINE への送信」を無効化する。紐付けは消さない。
後者は既存 push API と通知の両方を止める。テスト・実送信・再起動は本委託では未実施。
