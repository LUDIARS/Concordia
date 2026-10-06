---
type: feature
title: "連合リンク基盤 (マルチ拠点 Phase 0+1+2)"
description: "本社 ⇄ 拠点 (site) の WebSocket 連合リンク。別ポートの専用 listener (opt-in)・事前共有トークン認証・切断中 outbox・ハートビート・WebUI 拠点一覧・担当サーバスコープ設定配布。"
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
| 配布用 設定スナップショット (担当サーバスコープ + allowlist) | `src/federation/config-snapshot.ts` |
| 拠点側 設定キャッシュ (オフライン起動用) | `src/federation/config-cache.ts` |
| ロール配線 (env → repo / listener / client、opt-in 起動) | `src/federation/runtime.ts` |
| 管理 API (loopback /v1 面) | `src/api/federation.ts` |
| WebUI 拠点一覧 | `web/src/pages/Federation.tsx` (`/federation`) |

## 信頼境界 (Phase 0)

- 連合 listener は `node:http` の専用サーバ + `WebSocketServer` で、既存 `/v1`
  (loopback 信頼境界) とは**別ポート・別 origin**。`isLoopbackHost` の起動時拒否は
  変更していない。
- 既定 OFF。`federation-role-settings.md` の DB → env 解決後に enabled + port
  (明示必須、暗黙の既定 port なし) が揃った場合だけ有効化。port は Excubitor catalog に
  登録してから運用する。
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

- 配布単位は拠点の**担当担当サーバ** (`federation_sites.departments` = guild id の JSON 配列)。
  本社の `discord_config.guild_id` が担当に含まれない拠点へは Discord 設定を一切渡さない
  (`src/federation/config-snapshot.ts`)。担当判定を**値を読む前**に行うのは意図的で、
  「読んでから除外」形式だと除外漏れ 1 箇所で担当サーバ外の値が流出するため。
- 渡す Discord 設定キーは固定 allowlist (`FEDERATION_DISCORD_CONFIG_ALLOWLIST`、guild /
  category / forum / channel の id のみ)。`bot_token` 等の秘密は allowlist に無いので
  拠点へは出ない。delegation テンプレートは `id / call_name / title / target_provider /
  model` だけを渡し、`prompt_template` は本社に留める。
- 配布の契機は 2 つだけ: link 確立直後の `config-snapshot` と、管理 API
  (`POST /v1/federation/sites/:id/config`) による明示再配布の `config-update`。
  担当担当サーバの変更 (`PUT …/departments`) は自動再配布しない — 縮小した担当を拠点へ即時
  反映したい場合は再配布を明示的に呼ぶ。オフライン拠点への再配布は `delivered:false`
  を返し、次回の link 時に `config-snapshot` で追いつく。
- 拠点は受け取った正本を `.federation-config-cache.json` (既定は cwd、
  `configCachePath` で上書き可・`.gitignore` 済み) に保存し、オフライン起動時だけ
  これを使う。link 後は本社の値が唯一の正本として必ずキャッシュを置き換える。
  壊れた / 形式違反のキャッシュは読み捨てて未設定として起動する。

## 設定 (ロール設定は DB → env、全て opt-in)

listener と拠点クライアントの DB キー/API は [federation-role-settings.md](federation-role-settings.md) を正本とし、下表の env はフォールバックとして残す。outbox / Villa は従来どおり env で解決する。

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
| `CONCORDIA_VILLA_URL` | 拠点タグ解決に使う Villa の URL (既定 `http://127.0.0.1:17610`) |

## DB (v43 → v46)

- `federation_sites` — 拠点登録簿。`token_enc` は secret-box (`enc:v1:…`) で at-rest
  暗号化。status は `active | revoked`。`departments` (v45) は担当 guild id の JSON 配列
  (既定 `[]` = 設定を渡さない)。repo 境界で decode / 重複除去して `string[]` で返す。
  `villa_pc_id` (v46) は Villa の PC id (`state.pcs[].id`、既定 NULL = 拠点タグ無し)。
  PC 名ではなく id を持つのは、Villa 側の改名で対応が切れないようにするため。
- `federation_outbox` — 拠点別キュー。`seq` (AUTOINCREMENT) が配送順序。上限 / TTL
  超過は最古から破棄し、破棄件数を `reportError("federation", …)` でエラーチャンネルへ
  通知する。

## 拠点タグによる実行先指定

Session Forum は Villa の PC 名を拠点タグとして表示する。候補は `status = active` かつ
`federation_sites.villa_pc_id` が設定された拠点だけであり、PC 名は Concordia に固定せず
Villa `GET /api/state` の `state.pcs[].name` を使う。対応は PC 名 → `pcs[].id` →
`villa_pc_id` → site の順で解決する。

- 拠点タグは 1 個だけ有効で、複数なら曖昧として本社へ退避しエラーを記録する。
- 有効な拠点タグは担当サーバ (guild) ルーティングより優先する。タグがなければ従来どおり担当サーバで決める。
- 失効済み・対応づけのないPC名は拠点指定なしとして扱い、理由を warn する。
- Villa が停止・取得不能なら、有効な拠点の表示名 (無ければ site_id) を拠点タグ候補にする
  (§本社からのセッション起動)。例外は出さず、タグが無ければ既存の guild ルーティングを継続する。
- Discord の20文字・20個のタグ上限や既存タグとの衝突ではタグを作らず warn する。拠点タグは
  「あれば良い」扱いで、上限に当たっても作業種別等の必須タグ同期は止めない。
- 同一内容の warn は反復抑止する (レイアウト同期は定期実行、ingress は 1 メッセージごとに
  評価されるため、素通しだと errors チャンネルが同じ警告で埋まる)。

## 本社からのセッション起動 (Phase 4 の spawn 指示)

2026-10-06 neco 指示「本社から他拠点の Cc でセッションを開きたい」。本社の Session forum に
拠点タグを付けて投稿すると、本社では起動せず、その拠点の Cc がセッションを起動する。
拠点は Bot トークンを持たないので、スレッドへの投稿はすべて本社が egress で代行する。

| 責務 | 実装 |
|---|---|
| 本社 → 拠点の event payload (`spawn` / `ingress`) の型と検証 | `src/federation/remote-session-payload.ts` |
| スレッド台帳 (本社: スレッド → 拠点 / 拠点: スレッド → guild) | `src/federation/remote-thread-registry.ts` |
| 拠点側の処理 (起動・返信の注入・発言の中継) | `src/federation/remote-session-site.ts` |
| 拠点側の配線 (spawn API・sessions・eventBus) | `src/federation/remote-session-wiring.ts` |
| 本社側の振り分け (`routeForumSpawn`) と egress 許可 | `src/federation/runtime.ts` |
| forum 起動の差し込み口 (`routeRemoteSpawn`) | `src/discord/forum-spawn.ts` |

流れ:

1. 本社: forum 起動 (`executeForumSpawn`) は題名・本文を読んだ直後、拠点タグを `routeForumSpawn` に
   渡す。拠点に解決できて listener が動いていれば、スレッド台帳 (`federation.hq.remote_threads`) に
   スレッド → 拠点を記録し、`spawn` payload (題名・本文・ランタイムルールタグ・依頼者) を outbox へ
   積んで、スレッドに「拠点に依頼した」と返す。本社では起動しない。拠点指定が無い・listener 停止中は
   従来どおり本社で起動する。子会社 Bot は振り分けない。
2. 拠点: 連合クライアントの `onEvent` が payload を受ける。`spawn` はスレッド台帳
   (`federation.site.remote_threads`) に記録できたときだけ、forum 起動と同じ依頼文で自分の
   `/v1/admin/spawn-session` を呼ぶ (再送は冪等)。結果 (起動した / 失敗した) をスレッドへ返す。
3. 本社: スレッドへの人の返信は既存の ingress 転送 (拠点タグで拠点へ) で `ingress` payload になる。
   拠点は台帳にあるスレッドだけを扱い、forum の最初の投稿 (message id = thread id) は spawn 本文と
   重複するので捨てる。起動元スレッド (`discord_source_channel_id`) が一致する稼働中セッションへ
   `discord:<user>:<message>` の source で注入する (人の入力として扱われる)。セッションが無ければ
   「準備中か終了」とスレッドへ返す。
4. 拠点: canonical `session.message` (create・assistant) のうち、起動元スレッドが台帳にあるものを
   1800 文字ごとに egress 要求で本社スレッドへ返す。
5. 本社: egress 要求は、台帳でそのスレッドをその拠点へ渡していれば担当サーバ設定に関係なく通す。
   それ以外は従来どおり担当サーバで検証する。

依頼文での名指し (2026-10-06 neco 指示「GROMAC で xxxx やる、みたいな形で委託もできるように」): 拠点タグが無いときは、
題名か本文の先頭が「<拠点>で」(題名先頭の `[Cc]` などの括弧は飛ばす)、または `@<拠点>` を含む依頼をその拠点で起動する
(`resolveSiteFromText`)。拠点は有効な拠点の表示名か site_id と大文字小文字を区別せずに照らす。文中で拠点名に触れただけ
(「前に GROMAC で動いた件」など) は振り分けない。2 つ以上名指しされたら本社へ退避して warn する。拠点タグがあればタグを優先する。

拠点タグの候補: Villa から PC が取れれば従来どおり PC 名。取れない (Villa 停止・API 不一致) ときは
有効な拠点の表示名 (無ければ site_id、20 文字で切る) をタグにし、同じ名前で解決する
(`siteNameTagsOf` / `resolveSiteFromSiteNameTags`)。曖昧なら本社へ退避して warn する。

運用の前提 (人の設定): 本社の listener 有効化 (ポート・待ち受けアドレス)、各拠点 Cc の本社 URL・
拠点 ID・トークン。拠点側に別の Discord Bot を同じ guild へ繋いでいる構成は想定しない (二重投稿になる)。

## API (loopback /v1 面のみ)

- `GET /v1/federation` — listener 有効フラグ + 拠点一覧 (登録情報 + 担当担当サーバ +
  ライブ接続状態 + 未配送数)。トークンは返さない。
- `POST /v1/federation/sites` `{site_id, name?}` — 登録 + トークン発行。平文トークンは
  この応答のみ。
- `POST /v1/federation/sites/:id/revoke` — 失効 + 接続中なら切断。
- `PUT /v1/federation/sites/:id/departments` `{departments: string[]}` — 担当 guild の
  設定 (重複は除去、最大 100 件)。未登録拠点は 404。配布はしない。
- `PUT /v1/federation/sites/:id/villa-pc` `{villa_pc_id: string | null}` — 拠点タグに使う
  Villa PC の対応設定 (`null` で解除)。未登録拠点は 404。
- `POST /v1/federation/sites/:id/config` — 現在の設定を明示再配布。応答の `delivered` は
  live 接続へ `config-update` を送れたか (オフライン / listener 無効なら false)。
  失効済み / 未登録拠点は 404。

## イベント

`federation.site.connected` / `federation.site.disconnected` (site_id, ts) を
eventBus に emit。WebUI 拠点一覧 (`/federation`) の再取得トリガ。
