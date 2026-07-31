---
type: feature
title: "連合リンク基盤 (マルチ拠点 Phase 0+1+2)"
description: "本社 ⇄ 拠点 (site) の WebSocket 連合リンク。別ポートの専用 listener (opt-in)・事前共有トークン認証・切断中 outbox・ハートビート・WebUI 拠点一覧・部署スコープ設定配布。"
service: concordia
domain: federation
tags:
  - federation
  - multi-site
  - websocket
status: implemented
related:
  - ../plan/multi-site-federation.md
  - ../feature/trust-boundaries.md
  - ../interface/service-schema.md
  - ../tasks/2026-07-31-federation-phase2-config.md
updated: 2026-07-31
---

# 連合リンク基盤 (マルチ拠点 Phase 0+1+2)

[../plan/multi-site-federation.md](../plan/multi-site-federation.md) の Phase 0
(信頼境界の分離) + Phase 1 (連合リンク基盤) + Phase 2 (設定配布) の実装仕様。

用語: 設計書の「子会社」は実装では **site (拠点)** と呼ぶ。既存の `subsidiary`
(出張所 Bot、`/v1/subsidiaries`) とは別概念で、識別子を共有しない。

## 構成

| 責務 | 実装 |
|---|---|
| wire protocol v1 (hello/welcome/event/ack/error) | `src/federation/protocol.ts` |
| 本社 listener (別ポート・WS 専用・opt-in) | `src/federation/hq-listener.ts` |
| 拠点クライアント (outbound・指数バックオフ) | `src/federation/site-client.ts` |
| ライブ接続レジストリ (WebUI 供給) | `src/federation/hq-connections.ts` |
| 拠点登録簿 (トークン at-rest 暗号化) | `src/db/federation-sites-repo.ts` |
| 切断中キュー (上限 + TTL、最古破棄) | `src/db/federation-outbox-repo.ts` |
| 配布用 設定スナップショット (部署スコープ + allowlist) | `src/federation/config-snapshot.ts` |
| 拠点側 設定キャッシュ (オフライン起動用) | `src/federation/config-cache.ts` |
| ロール配線 (env → repo / listener / client、opt-in 起動) | `src/federation/runtime.ts` |
| 管理 API (loopback /v1 面) | `src/api/federation.ts` |
| WebUI 拠点一覧 | `web/src/pages/Federation.tsx` (`/federation`) |

## 信頼境界 (Phase 0)

- 連合 listener は `node:http` の専用サーバ + `WebSocketServer` で、既存 `/v1`
  (loopback 信頼境界) とは**別ポート・別 origin**。`isLoopbackHost` の起動時拒否は
  変更していない。
- 既定 OFF。`CONCORDIA_FEDERATION_LISTEN=1` + `CONCORDIA_FEDERATION_LISTEN_PORT`
  (明示必須、暗黙の既定 port なし) で有効化。port は Excubitor catalog に登録してから
  運用する。
- HTTP リクエストは全て 404 — 連合面で受け付ける操作は protocol.ts のフレームのみで、
  `/v1` への透過転送経路は存在しない。
- TLS は前段のトンネル / 逆プロキシで終端する。拠点クライアントは loopback 以外への
  平文 `ws://` を拒否する (`resolveHqEndpoint`)。

## プロトコル (v1)

```
site → hq : {"v":1,"type":"hello","site_id":"...","token":"...","site_version":"..."}
hq → site : {"v":1,"type":"welcome","hq_version":"...","pending_events":N}
hq → site : {"v":1,"type":"event","seq":N,"payload":<opaque JSON>}
hq → site : {"v":1,"type":"config-snapshot","snapshot":{...}}   (link 確立直後の正本)
hq → site : {"v":1,"type":"config-update","snapshot":{...}}     (明示再配布された正本)
site → hq : {"v":1,"type":"ack","seq":N}
hq → site : {"v":1,"type":"error","code":"auth_failed|unsupported_version|invalid_frame|replaced|revoked","message":"..."}
```

- `ConcordiaEvent` とは独立したスキーマ。互換は `v` で管理する (設計書の未決事項を
  「専用スキーマ + バージョン」で確定)。
- hello は接続後 10 秒以内・先頭フレーム必須。トークン照合は定数時間
  (`secureValuesMatch`)、認証失敗は remote 単位のレート制限 (60 秒窓 5 回) + 監査ログ。
  トークン照合が通った remote の失敗記録は破棄する (成功後の再接続を弾かないため)。
  運用上の注意: remote は TCP 接続元アドレスなので、複数拠点が同じトンネル / 逆プロキシ
  を経由すると全拠点が 1 つの remote に見える (1 拠点の設定ミスが他拠点を 60 秒間
  弾きうる)。拠点ごとに経路を分けるか、拠点 ID 単位の制限へ切り替える (未実装)。
- 認証前の相手に資源を積ませない上限: 受信フレーム 8KB (`maxPayload`。ws 既定の
  100MB は使わない)、hello 待ち接続の同時数 全体 64 / remote あたり 4 (超過は `1013`)。
  remote 別上限が無いと、1 つの発信元が hello を送らない接続を張り替え続けるだけで
  全拠点の再接続を締め出せる。拒否理由の監査ログに出す相手由来の文字列は 120 文字で
  切る (ログ埋め対策)。
- event は seq 昇順で配送し、site は受領済み最大 seq を ack、hq は seq 以下を削除する。
  ack は hq が実際に送った seq (接続ごとの `lastSentSeq`) で上限を切る — 認証済みの拠点でも
  未配送分を ack で消せないようにする (静かなイベント欠落の防止)。
  再接続直後は送信済み未 ack 分が再送されうる (**at-least-once**)。payload の解釈は
  Phase 2+ (Phase 1 では payload は不透明で、消費者側の冪等化は Phase 2 で定義する)。
- 死活は WS プロトコル ping/pong (本社が 25 秒間隔で ping、2 回無応答で切断)。拠点側も
  本社からの受信が 70 秒途絶えたら自分から terminate して再接続する (経路断・本社の
  異常終了は TCP が半開のまま close を起こさないため、拠点が「接続中」のまま固まるのを防ぐ)。
- 同一拠点の新規接続は旧接続を置き換える (`replaced`)。hq 側から切る場合 (`replaced` /
  `revoked`) はライブレジストリから即座に外す — 経路断で TCP が半開のままだと close が
  来ないので、失効済み拠点へ配送が続かないようにする。
- `revoked` / `auth_failed` を受けた拠点クライアントは再接続を止め、
  `reportError("federation", …)` で拠点側エラーチャンネルへ通知する
  (人間の再設定が必要なため、黙って畳まない)。

## 設定配布 (Phase 2)

設定の正本は本社だけが持ち、拠点へは**接続ごとに組み立てた読み取り専用スナップショット**
として渡す。拠点から本社の設定を書き換える経路は無い。

- 配布単位は拠点の**担当部署** (`federation_sites.departments` = guild id の JSON 配列)。
  本社の `discord_config.guild_id` が担当に含まれない拠点へは Discord 設定を一切渡さない
  (`src/federation/config-snapshot.ts`)。担当判定を**値を読む前**に行うのは意図的で、
  「読んでから除外」形式だと除外漏れ 1 箇所で部署外の値が流出するため。
- 渡す Discord 設定キーは固定 allowlist (`FEDERATION_DISCORD_CONFIG_ALLOWLIST`、guild /
  category / forum / channel の id のみ)。`bot_token` 等の秘密は allowlist に無いので
  拠点へは出ない。delegation テンプレートは `id / call_name / title / target_provider /
  model` だけを渡し、`prompt_template` は本社に留める。
- 配布の契機は 2 つだけ: link 確立直後の `config-snapshot` と、管理 API
  (`POST /v1/federation/sites/:id/config`) による明示再配布の `config-update`。
  担当部署の変更 (`PUT …/departments`) は自動再配布しない — 縮小した担当を拠点へ即時
  反映したい場合は再配布を明示的に呼ぶ。オフライン拠点への再配布は `delivered:false`
  を返し、次回の link 時に `config-snapshot` で追いつく。
- 拠点は受け取った正本を `.federation-config-cache.json` (既定は cwd、
  `configCachePath` で上書き可・`.gitignore` 済み) に保存し、オフライン起動時だけ
  これを使う。link 後は本社の値が唯一の正本として必ずキャッシュを置き換える。
  壊れた / 形式違反のキャッシュは読み捨てて未設定として起動する。

## 設定 (env、全て opt-in)

| 変数 | 意味 |
|---|---|
| `CONCORDIA_FEDERATION_LISTEN=1` | 本社ロール: listener 有効化 |
| `CONCORDIA_FEDERATION_LISTEN_HOST` | listener bind host (既定 127.0.0.1) |
| `CONCORDIA_FEDERATION_LISTEN_PORT` | listener port (有効化時は必須) |
| `CONCORDIA_FEDERATION_HQ_URL` | 拠点ロール: 本社 URL (`wss://…`) |
| `CONCORDIA_FEDERATION_SITE_ID` | 拠点 ID (`[a-z0-9][a-z0-9-]{1,63}`) |
| `CONCORDIA_FEDERATION_SITE_TOKEN` | 発行済みトークン |
| `CONCORDIA_FEDERATION_OUTBOX_MAX` | outbox 上限行数 / 拠点 (既定 10000) |
| `CONCORDIA_FEDERATION_OUTBOX_TTL_SEC` | outbox TTL 秒 (既定 604800) |

## DB (v43 → v45)

- `federation_sites` — 拠点登録簿。`token_enc` は secret-box (`enc:v1:…`) で at-rest
  暗号化。status は `active | revoked`。`departments` (v45) は担当 guild id の JSON 配列
  (既定 `[]` = 設定を渡さない)。repo 境界で decode / 重複除去して `string[]` で返す。
- `federation_outbox` — 拠点別キュー。`seq` (AUTOINCREMENT) が配送順序。上限 / TTL
  超過は最古から破棄し、破棄件数を `reportError("federation", …)` でエラーチャンネルへ
  通知する。

## API (loopback /v1 面のみ)

- `GET /v1/federation` — listener 有効フラグ + 拠点一覧 (登録情報 + 担当部署 +
  ライブ接続状態 + 未配送数)。トークンは返さない。
- `POST /v1/federation/sites` `{site_id, name?}` — 登録 + トークン発行。平文トークンは
  この応答のみ。
- `POST /v1/federation/sites/:id/revoke` — 失効 + 接続中なら切断。
- `PUT /v1/federation/sites/:id/departments` `{departments: string[]}` — 担当 guild の
  設定 (重複は除去、最大 100 件)。未登録拠点は 404。配布はしない。
- `POST /v1/federation/sites/:id/config` — 現在の設定を明示再配布。応答の `delivered` は
  live 接続へ `config-update` を送れたか (オフライン / listener 無効なら false)。
  失効済み / 未登録拠点は 404。

## イベント

`federation.site.connected` / `federation.site.disconnected` (site_id, ts) を
eventBus に emit。WebUI 拠点一覧 (`/federation`) の再取得トリガ。
