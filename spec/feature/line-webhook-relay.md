---
type: feature
title: "LINE Messaging API の webhook を Cc 1 か所で受けてサービスへ転送する"
service: concordia
domain: line-webhook-relay
status: implemented
updated: 2026-10-18
related:
  - ./web-sso.md
  - ./trust-boundaries.md
---

# LINE webhook の受け口と転送

Actio タスク: `actio:605bbdbf-c384-4d31-9860-6b5d090dbcee` (neco 指示 2026-10-18)。

LUDIARS の各サービス (最初は MemoriaForChild) が LINE 公式アカウントを使う。LINE の webhook URL を
サービスごとに公開せず、Cc の 1 か所で受けて登録した転送先へそのまま渡す。

**将来は Conexus へ移す。** いまは置き場所が無いので Cc に置く。受け口・転送・登録はこの節と
`src/line-webhook/` に閉じており、Cc の他の機能に依存しない (Conexus へ移すときはこのディレクトリと
設定 1 項目を持っていけばよい)。

## 価値・シナリオ

- UX-CC-W12 / UX-CC-S13: neco が LINE Developers の webhook URL に `https://<公開ホスト>/hooks/line/mf` を設定し、
  検証ボタンを押すと、Cc が MemoriaForChild へ転送し、MemoriaForChild の署名検証の結果 (200 / 401 等)
  がそのまま検証ボタンに返る。サービスを足すときは Cc の設定に転送先を 1 行足すだけで、サービス側に
  公開 URL は要らない。

## 受け口

`POST /hooks/line/:target` (`:target` は登録した転送先の名前。英小文字・数字・ハイフン)。

- LINE-WH-INV-01: Cc の認証 (公開ホストの Web SSO / CF Access) を掛けない唯一の経路。`buildApp` は
  この経路を SSO と応答キャッシュのミドルウェアより前に登録し、ここで応答を返して後続へ進めない。
  他の経路は今まで通り認証を要求する。
- LINE-WH-INV-02: POST 以外のメソッド・未登録・`enabled: false`・名前形式違反・入れ子のパスは 404
  (認証画面や Web 画面の fallback へ落とさない)。
- LINE-WH-INV-03: 本文は受けたままのバイト列で扱う (JSON を読み直して書き直さない。署名が壊れる)。
  上限 1 MB、超えたら 413。
- LINE-WH-INV-04: 応答キャッシュを通さない (`cache-control: no-store`)。ログに本文と署名を残さない
  (target・status・所要時間・本文バイト数だけ)。

## 転送

- LINE-WH-INV-05: 登録した転送先 URL へ、本文そのままと `Content-Type`・`X-Line-Signature` だけを付けて
  POST する。`cf-*` / `x-forwarded-*` / `Cookie` / `Authorization` は付けない (許可リスト方式)。
- LINE-WH-INV-06: 転送先に `host` があれば Host ヘッダをそれにする (MemoriaForChild は連携専用
  ホスト名の Host で来た `/integrations/` だけを Access 免除にしているため)。無ければ URL のホスト。
- LINE-WH-INV-07: 転送先のステータスと本文をそのまま返す (常に 200 にはしない。LINE の検証ボタンで
  本当に通るか分かるように)。転送先がタイムアウト (既定 5 秒) / 接続失敗なら 502。
- 署名の検証は Cc ではしない。channel secret はサービス側の DB が正本で、秘密を 2 系統にしない。
- 再送・キューイングはしない (LINE 側の再送に任せる)。
- 転送は `node:http(s)` で送る (fetch は Host を禁止ヘッダとして扱う実装があるため)。

## 転送先の登録

設定 `services.line_webhook_targets` (設定画面 > 兄弟サービス、schema_meta、秘密値ではない)。
1 行 1 件の JSON オブジェクト `{name, url, host?, enabled}` で書く。

```text
{"name":"mf","url":"http://192.0.2.10:8080/integrations/line/webhook","host":"mf-hook.example.test","enabled":true}
```

- LINE-WH-INV-08: `name` は英小文字・数字・ハイフン (64 文字以内)、`url` は http / https (資格情報入り
  不可)、`host` はホスト名 (任意で `:ポート`)、`enabled` は真偽値。未知のキー・重複名を含む更新は
  PUT で 400 にして保存しない (保存したのに効かない、を作らない)。
- 受け口は要求ごとに設定を読むので、保存すると再起動なしで効く。
- 実際の登録は親セッションが反映後に行う。

## 公開ホスト

公開ホスト名は親セッションが Excubitor の CF ブローカーで用意する (Tunnel 側でもパス `^/hooks/line/`
だけを通す)。

## 契約

| id | 対象 | 条件 |
|---|---|---|
| line-wh-C-1 | `parseLineWebhookTargets` (`src/line-webhook/targets.ts`) | 形式を満たす項目だけを転送先にし、壊れた項目・重複名は理由付きで errors に返す |
| line-wh-C-2 | `resolveLineWebhookTarget` (`src/line-webhook/targets.ts`) | 登録済みかつ enabled の同名転送先だけを返す |
| line-wh-C-3 | `buildRelayHeaders` (`src/line-webhook/relay-headers.ts`) | 転送ヘッダは許可リストの 4 本だけ |

## 実装の配置

| ファイル | 役割 |
|---|---|
| `src/line-webhook/targets.ts` | 転送先の解釈・検証・解決 (LINE-WH-INV-02, 08) |
| `src/line-webhook/relay-headers.ts` | 転送ヘッダの取捨と Host 上書き (LINE-WH-INV-05, 06) |
| `src/line-webhook/relay.ts` | 転送先への POST とタイムアウト (LINE-WH-INV-03, 07) |
| `src/line-webhook/route.ts` | 受け口・本文上限・応答とログ (LINE-WH-INV-01〜04, 07) |
| `src/line-webhook/ontime-runtime.ts` | observe 契約の runtime 再公開 |
| `src/app.ts` | SSO・応答キャッシュより前に受け口を登録 (LINE-WH-INV-01) |
| `src/config/settings/definitions/platform.ts` | 設定項目 `services.line_webhook_targets` |
| `src/config/settings/apply.ts` / `types.ts` / `definitions/index.ts` | string-list の項目ごとの検証 (`validateItems`) |

## 戻し方

設定 `services.line_webhook_targets` を空にすると受け口はすべて 404 になる。公開ホスト側の
`^/hooks/line/` を外せば外からは届かない。
