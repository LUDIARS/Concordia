# 連合ロールの設定を Concordia 内で完結させる

## 目的

連合の本社ロール (listener) と拠点ロール (site client) は env でしか有効化できず、
env を注入するのは Excubitor だった。連合は Concordia 自身の機能なのに、実質
**Excubitor 無しでは拠点を受けられない / 繋げられない**状態になっていた
(2026-08-09 neco 指示: Excubitor 依存の多い作りにしない)。

env は代替手段として残し、**正本を Concordia の設定 (schema_meta) に置く**。

## 設定キーと解決

解決順は **DB → env → 既定**。`WorkflowToggles` と同じく呼ばれるたびに解決し、
変更は再起動なしで反映される (既定 10 秒間隔の同期)。

| キー | env フォールバック | 既定 |
|---|---|---|
| `admin.federation.listen.enabled` | `CONCORDIA_FEDERATION_LISTEN` | 無効 |
| `admin.federation.listen.port` | `CONCORDIA_FEDERATION_LISTEN_PORT` | なし (有効化には必須) |
| `admin.federation.listen.host` | `CONCORDIA_FEDERATION_LISTEN_HOST` | `127.0.0.1` |
| `admin.federation.site.hq_url` | `CONCORDIA_FEDERATION_HQ_URL` | なし |
| `admin.federation.site.site_id` | `CONCORDIA_FEDERATION_SITE_ID` | なし |
| `admin.federation.site.token_enc` | `CONCORDIA_FEDERATION_SITE_TOKEN` | なし |

- **既定ポートは作らない**。`enabled=true` にポートが伴わない更新は 400 で拒否する
  (待ち受け先の取り違えを事故にしないため)。
- 拠点トークンは **SecretBox で暗号化**して保存し、API からは「設定済みか」しか返さない。
- nullable 項目へ `null` を PUT した場合は DB 上書きを削除し、env / 既定へ戻す。
- 保存済みトークンを復号できない場合は env へフォールバックしつつ、運用エラーとして表面化する。
- 拠点ロールは hq_url / site_id / token の **3 つ揃って初めて**起動する。
  一部だけ設定された状態は黙って無効化せず warn を出す。

## API (loopback)

```
GET  /v1/federation/listener   → {enabled, port, host, source, running}
PUT  /v1/federation/listener   {enabled?, port?, host?}
GET  /v1/federation/site       → {hqUrl, siteId, hasToken, source, running}   # token は返さない
PUT  /v1/federation/site       {hq_url?, site_id?, token?}
```

`PUT` は設定を保存したあと**その場で listener / クライアントを張り替えてから**応答する。
応答の `running` は張り替え後の実状態なので、成否がそのまま分かる。

## 張り替えの規則

- listener: `enabled` が落ちたら close、port/host が変わったら close → open。
  起動失敗時は待ち受け束縛を立てないので、次の同期で同じ設定のまま再試行される
  (ポートが空くまで待てる)。失敗は `reportError` で表面化する。
- 拠点クライアント: 3 値のどれかが変わったら stop → start。
- どちらも `stop()` で poll ごと止める。

## 非対象

- 拠点側の初回ブートストラップも API で完結する (loopback に PUT するだけ)。env は不要。
- Villa PC 対応や担当 guild の設定は既存 API のまま。
