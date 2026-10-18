---
type: feature
title: "LINE のチャネルを Cc が持ち、webhook を検証してサービスへ中継し、返信を代行する"
service: concordia
domain: line-webhook-relay
status: implemented
updated: 2026-10-18
related:
  - ./web-sso.md
  - ./trust-boundaries.md
---

# LINE webhook のハブ (受け口・検証・中継・返信)

Actio タスク: `actio:605bbdbf-c384-4d31-9860-6b5d090dbcee` (受け口の新設)、
`actio:54cb27c9-b772-4e8d-baf2-e17d01d95ce3` (チャネルを Cc が持つハブへの作り変え)。

LUDIARS の各サービス (最初は MemoriaForChild = Mf) が LINE 公式アカウントを使う。LINE の webhook URL を
サービスごとに公開せず、Cc の 1 か所で受ける。

neco 決定 (2026-10-18): **LINE のチャネルシークレットとチャネルアクセストークンは Cc が持つ。**
署名の検証と LINE への返信は Cc が行い、サービスは返事の中身だけを返す。

**将来は Conexus へ移す。** いまは置き場所が無いので Cc に置く。受け口・検証・中継・返信・秘密値の管理は
この節と `src/line-webhook/` に閉じており、Cc の他の機能に依存しない (Conexus へ移すときはこのディレクトリと
設定 1 項目・秘密値のキー `line_webhook.<target>.*` を持っていけばよい)。

## 価値・シナリオ

- UX-CC-W12 / UX-CC-S13: neco が LINE Developers の webhook URL に `https://<公開ホスト>/hooks/line/mf` を設定し、
  検証ボタンを押すと、Cc が署名を検証して MemoriaForChild へ中継し、結果 (200 / 401 / 503 / 502) が検証ボタンに
  返る。サービスを足すときは Cc の設定に転送先を 1 行足し、設定画面で秘密値を 3 つ入れるだけで、サービス側に
  公開 URL も LINE の秘密値も要らない。

## 流れ

1. LINE → `POST https://<公開ホスト>/hooks/line/:target` (Cc)。
2. Cc は target のチャネルシークレットで `X-Line-Signature` を検証する (§署名の検証)。
3. Cc → サービス: `POST <target.url>` に本文のバイト列そのままと中継トークンを付けて送る (§転送)。
4. サービス → Cc: `{"replies":[{"replyToken","messages":[...]}]}` を返す (§サービスの応答と LINE への返信)。
5. Cc は LINE へ 200 `{}` を返し、replies を LINE reply API へ送る。

## 受け口

`POST /hooks/line/:target` (`:target` は登録した転送先の名前。英小文字・数字・ハイフン)。

- LINE-WH-INV-01: Cc の認証 (公開ホストの Web SSO / CF Access) を掛けない唯一の経路。`buildApp` は
  この経路を SSO と応答キャッシュのミドルウェアより前に登録し、ここで応答を返して後続へ進めない。
  他の経路 (秘密値の管理 API を含む) は今まで通り認証を要求する。
- LINE-WH-INV-02: POST 以外のメソッド・未登録・`enabled: false`・名前形式違反・入れ子のパスは 404
  (認証画面や Web 画面の fallback へ落とさない)。
- LINE-WH-INV-03: 本文は受けたままのバイト列で扱う (JSON を読み直して書き直さない。署名が壊れる)。
  上限 1 MB、超えたら 413。
- LINE-WH-INV-04: 応答キャッシュを通さない (`cache-control: no-store`)。ログ・応答に秘密値・本文・署名・
  replyToken・メッセージを出さない (target・status・所要時間・本文バイト数・サービスの status・返信件数だけ)。

## 署名の検証

- LINE-WH-INV-09: `X-Line-Signature` は受けた本文バイト列の、target のチャネルシークレットによる
  HMAC-SHA256 の base64。一致しなければ 401 `{"error":"signature_rejected"}` で、サービスへは送らない。
- LINE-WH-INV-10: target のチャネルシークレットか中継トークンが未設定 (復号できない値を含む) なら
  503 `{"error":"line_channel_not_configured"}` で、サービスへは送らない。中継トークンが無いとサービスは
  必ず 401 で落とすため、シークレット未設定と同じ扱いにする。

## 転送

- LINE-WH-INV-05: 登録した転送先 URL へ、本文そのままと次のヘッダだけを付けて POST する (許可リスト方式)。
  `Content-Type: application/json`、`Authorization: Bearer <中継トークン>`、`X-Concordia-Line-Target: <target 名>`、
  `Content-Length`。`X-Line-Signature` は Cc が検証済みなので送らない。`cf-*` / `x-forwarded-*` / `Cookie` も送らない。
- LINE-WH-INV-06: 転送先に `host` があれば Host ヘッダをそれにする (MemoriaForChild は連携専用
  ホスト名の Host で来た `/integrations/` だけを Access 免除にしているため)。無ければ URL のホスト。
- 再送・キューイングはしない (LINE 側の再送に任せる)。
- 転送は `node:http(s)` で送る (fetch は Host を禁止ヘッダとして扱う実装があるため)。

## サービスの応答と LINE への返信

サービスは中継トークンが合えば 200 と次の本文を返す (返事が無ければ `{"replies":[]}`)。

```json
{"replies":[{"replyToken":"<イベントの replyToken>","messages":[{"type":"text","text":"..."}]}]}
```

サービス側の取り決め: 中継トークン未発行 → 503 `{"error":"integration_not_configured"}`、
不一致・欠落 → 401 `{"error":"relay_token_rejected"}`、本文不正 → 400。

- LINE-WH-INV-07: サービスが 2xx で本文が上の形 (replyToken は空でない文字列、messages は 1〜5 件の
  オブジェクト) なら、LINE へ 200 `{}` を返す。サービスが 2xx 以外 / タイムアウト (5 秒) / 接続失敗 /
  応答 JSON の形が違う → LINE へ 502 `{"error":"upstream_failed","status":<サービスの status か null>}` を返し、
  返信はしない (LINE Developers の「検証」で失敗が見えるように)。
- LINE-WH-INV-11: replies の各要素を LINE reply API (`POST https://api.line.me/v2/bot/message/reply`、
  `Authorization: Bearer <チャネルアクセストークン>`、本文 `{replyToken, messages}`) へ送る。LINE への応答を
  返した後に送る。返信の失敗 (チャネルアクセストークン未設定を含む) はログ (target と status だけ) に残し、
  LINE への 200 は変えない。messages の中身は解釈せずそのまま渡す。
- reply API の呼び出しは受け口の依存 (`sendReply`) として差し替えられ、テストでは実 LINE を呼ばない。
  URL はコード定数 `LINE_REPLY_API_URL` (送信器の生成時に差し替えられる)。

## チャネルの秘密値

target ごとに次の 3 つを持つ。

| 項目 (`field`) | 用途 | 出所 |
|---|---|---|
| `channel_secret` | 署名の検証 | LINE Developers のチャネル基本設定 |
| `channel_access_token` | LINE reply API の呼び出し | LINE Developers の Messaging API 設定 (長期トークン) |
| `relay_token` | サービスへの転送の `Authorization` | サービス側 (Mf の親の設定) が発行し、平文を発行時に 1 度だけ画面に出す。人間がその値を貼る |

- LINE-WH-INV-12: 置き場所は schema_meta のキー `line_webhook.<target>.<field>`。AdminState.store が
  secret-box で暗号化して保存するので、二重に暗号化しない。サービスは中継トークンのハッシュだけを持つ。
- LINE-WH-INV-13: 管理 API `/v1/admin/line-webhook` (設定画面 > LINE webhook) は値を書き込むだけで読み返さない。
  - `GET /targets` → 登録済み target ごとの `{name, enabled, channel_secret_set, channel_access_token_set, relay_token_set}`。
  - `PUT /targets/:target/secrets/:field` (`{"value":"..."}`) で入力・差し替え、`DELETE` で消去。応答は設定済みかどうかだけ。
  - 未登録の target・未知の field は 404、空 / 4096 文字超の値は 400 で保存しない。
- 秘密でない target 定義 (`services.line_webhook_targets` の name/url/host/enabled) は §転送先の登録 のまま。
- 実際の値の登録は親セッションが反映後に行う。

## 転送先の登録

設定 `services.line_webhook_targets` (設定画面 > 兄弟サービス、schema_meta、秘密値ではない)。
1 行 1 件の JSON オブジェクト `{name, url, host?, enabled}` で書く。

```text
{"name":"mf","url":"http://192.0.2.10:8080/integrations/line/webhook","host":"mf-hook.example.test","enabled":true}
```

- LINE-WH-INV-08: `name` は英小文字・数字・ハイフン (64 文字以内)、`url` は http / https (資格情報入り
  不可)、`host` はホスト名 (任意で `:ポート`)、`enabled` は真偽値。未知のキー・重複名を含む更新は
  PUT で 400 にして保存しない (保存したのに効かない、を作らない)。
- 受け口は要求ごとに設定と秘密値を読むので、保存すると再起動なしで効く。

## 公開ホスト

公開ホスト名は親セッションが Excubitor の CF ブローカーで用意する (Tunnel 側でもパス `^/hooks/line/`
だけを通す)。

## 契約

| id | 対象 | 条件 |
|---|---|---|
| line-wh-C-1 | `parseLineWebhookTargets` (`src/line-webhook/targets.ts`) | 形式を満たす項目だけを転送先にし、壊れた項目・重複名は理由付きで errors に返す |
| line-wh-C-2 | `resolveLineWebhookTarget` (`src/line-webhook/targets.ts`) | 登録済みかつ enabled の同名転送先だけを返す |
| line-wh-C-3 | `buildRelayHeaders` (`src/line-webhook/relay-headers.ts`) | 転送ヘッダは許可リストの 5 本だけで、X-Line-Signature を含まない |
| line-wh-C-4 | `verifyLineSignature` (`src/line-webhook/signature.ts`) | 本文バイト列の HMAC-SHA256 base64 と一致するときだけ true |
| line-wh-C-5 | `parseServiceReplies` (`src/line-webhook/replies.ts`) | 取り決めの形のときだけ返信の一覧を返し、それ以外は null |
| line-wh-C-6 | `describeLineChannelSecrets` (`src/line-webhook/channel-secrets.ts`) | 設定済みかどうかの真偽値だけを返す |

## 実装の配置

| ファイル | 役割 |
|---|---|
| `src/line-webhook/targets.ts` | 転送先の解釈・検証・解決 (LINE-WH-INV-02, 08) |
| `src/line-webhook/signature.ts` | 署名の検証 (LINE-WH-INV-09) |
| `src/line-webhook/relay-headers.ts` | 転送ヘッダと Host 上書き (LINE-WH-INV-05, 06) |
| `src/line-webhook/relay.ts` | 転送先への POST とタイムアウト (LINE-WH-INV-03, 07) |
| `src/line-webhook/replies.ts` | サービスの応答本文の解釈 (LINE-WH-INV-07) |
| `src/line-webhook/reply-client.ts` | LINE reply API の呼び出し (LINE-WH-INV-11) |
| `src/line-webhook/channel-secrets.ts` | target ごとの秘密値の読み書きと状態 (LINE-WH-INV-10, 12) |
| `src/line-webhook/admin-route.ts` | 秘密値の管理 API (LINE-WH-INV-13) |
| `src/line-webhook/route.ts` | 受け口・本文上限・検証・中継・返信・ログ (LINE-WH-INV-01〜04, 07, 09〜11) |
| `src/line-webhook/ontime-runtime.ts` | observe 契約の runtime 再公開 |
| `src/app.ts` | SSO・応答キャッシュより前に受け口を登録 (LINE-WH-INV-01) |
| `src/api/register-core.ts` | 管理 API を `/v1/admin/line-webhook` に登録 (LINE-WH-INV-13) |
| `src/bootstrap/core.ts` | 受け口へ転送先と秘密値 (AdminState.store) を渡す |
| `src/config/settings/definitions/platform.ts` | 設定項目 `services.line_webhook_targets` |
| `src/config/settings/apply.ts` / `types.ts` / `definitions/index.ts` | string-list の項目ごとの検証 (`validateItems`) |
| `web/src/pages/settings/sections/LineWebhookSecretsSection.tsx` | 設定画面 > LINE webhook (LINE-WH-INV-13) |

## 戻し方

設定 `services.line_webhook_targets` を空にすると受け口はすべて 404 になる。target の秘密値を消すと
その target は 503 になる。公開ホスト側の `^/hooks/line/` を外せば外からは届かない。
