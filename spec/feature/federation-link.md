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
- 拠点間の通信路は Tailscale (WireGuard で暗号化された tailnet) を正とする (2026-10-06 neco 判断)。
  tailnet 外へ出す場合は TLS を前段のトンネル / 逆プロキシで終端した `wss://` にする。
  判定は `src/federation/transport-policy.ts` (純関数) に集約する。
  - **CC-FED-T1**: 拠点クライアントは平文 `ws://` を loopback / tailnet の IP リテラル
    (100.64.0.0/10、fd7a:115c:a1e0::/48) 宛てだけ許す (`resolveHqEndpoint`)。ホスト名 (MagicDNS を含む) は
    解決先を検証できないので平文では許さない。
  - **CC-FED-T2**: 本社 listener は loopback / tailnet 以外からの接続を hello 前に close 1008 で切る。
    TLS 前段が tailnet 外のアドレスから繋ぐ構成だけ、env `CONCORDIA_FEDERATION_ALLOW_ANY_REMOTE=1` で外せる。
  - **CC-FED-T3**: `PUT /v1/federation/site` は T1 に反する `hq_url` を保存時点で 400 にする
    (起動後に拠点クライアントが例外で黙って止まらない)。
- 拠点 Concordia の拠点設定 (`PUT /v1/federation/site`) は loopback 限定のままにする。拠点の外から設定を入れるのは
  相互登録済みの Excubitor 依頼 `concordia-federation-site` だけで、本社側の手順は
  `tools/federation-provision-site.mjs` ([../setup/federation.md](../setup/federation.md))。token は依頼の記録に残さない。

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
| 本社側の egress 送信 (スレッドは親 channel の webhook + thread_id) | `src/discord/federation-egress.ts` |
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
   起動に失敗したら台帳から消し、再送で起動し直せるようにする。失敗ログには spawn-session の拒否理由を含める。
   {#SPEC-FED-REMOTE-SPAWN-CWD}
   起動場所: 本社は forum 起動の project 解決 (選択回答 → project code registry) で取れた project を
   `options.project` として渡す。拠点は project / cwd / template のどれも無い依頼に、自分の主 workspace root を
   cwd として補う (`withSiteDefaultCwd`)。spawn-session は cwd 無しの起動を `project cwd is required` で拒否するため
   (2026-10-11 MELPOT: プロジェクトを名指ししない拠点向け forum 投稿が全て HTTP 400 で起動しなかった)。
3. 本社: スレッドへの人の返信は既存の ingress 転送 (拠点タグで拠点へ) で `ingress` payload になる。
   拠点は台帳にあるスレッドだけを扱い、forum の最初の投稿 (message id = thread id) は spawn 本文と
   重複するので捨てる。起動元スレッド (`discord_source_channel_id`) が一致する稼働中セッションへ
   `discord:<user>:<message>` の source で注入する (人の入力として扱われる)。セッションが無ければ
   「準備中か終了」とスレッドへ返す。
4. 拠点: canonical `session.message` (create・assistant) のうち、起動元スレッドが台帳にあるものを
   1800 文字ごとに egress 要求で本社スレッドへ返す。
5. 本社: egress 要求は、台帳でそのスレッドをその拠点へ渡していれば担当サーバ設定に関係なく通す。
   それ以外は従来どおり担当サーバで検証する。
6. 本社: 通した egress は Discord ポート (`src/discord/federation-egress.ts`) が送る。宛先がスレッドなら
   webhook は親 channel / forum のものを使い `thread_id` を付ける (スレッド自身には webhook を作れない)。
   拒否・送信失敗は拠点へ返すだけでなく本社ログにも warn で残す (2026-10-11 MELPOT: スレッド宛ての
   egress が全て webhook 無しで失敗し、起動結果も発言も届かず「spawn できていない」に見えた)。
   {#SPEC-FED-EGRESS-THREAD}

依頼文での名指し (2026-10-06 neco 指示「GROMAC で xxxx やる、みたいな形で委託もできるように」): 拠点タグが無いときは、
題名か本文の先頭が「<拠点>で」(題名先頭の `[Cc]` などの括弧は飛ばす)、または `@<拠点>` を含む依頼をその拠点で起動する
(`resolveSiteFromText`)。拠点は有効な拠点の表示名か site_id と大文字小文字を区別せずに照らす。文中で拠点名に触れただけ
(「前に GROMAC で動いた件」など) は振り分けない。2 つ以上名指しされたら本社へ退避して warn する。拠点タグがあればタグを優先する。

### `/spawn` の起動先 (2026-10-07 neco 指示) {#SPEC-FED-SPAWN-SITE}

「spawnコマンドにspawnする拠点を設定できるように」「拠点は タグを用意 / プロジェクトと関連させて自動で対象のマシンで動作させる /
特定できなければ対象選択UI出す」。本社 Bot の `/spawn` は次の順に起動先を決める (`src/discord/commands/spawn-site.ts` の
`decideSpawnTarget`)。

1. `site` 指定 (補完は有効な拠点) — 拠点 ID か表示名 (大文字小文字を区別しない) で解決する。未知・失効・同名複数は理由を返して起動しない。
2. `project` を担当する拠点 — 拠点ごとの担当プロジェクト (`GET/PUT /v1/federation/sites/:id/projects`、設定ストア
   `federation.site_projects`) に 1 拠点だけあればそこで起動する。
3. 担当拠点が複数 — 起動者だけが操作できる選択メニュー (担当拠点 + 本社、120 秒) を出す。時間切れは起動しない。
4. それ以外 (担当なし・project なし・`task` 付き・子会社 Bot) は従来どおり本社で起動する。`task` は Memoria の完了連携を本社しか持たないので
   自動では拠点へ渡さず、`site` 明示との併用は断る。

拠点へは forum 起動と同じ `spawn` payload に任意の `options` (provider / template / inject_prompt / model / effort / project / branch / cwd) を
載せて渡し、拠点はそれを自分の `/v1/admin/spawn-session` へ渡す (effort は provider ごとのキーへ寄せる)。古い拠点は知らないキーを読み捨てる。
team は拠点へ渡せないので、provider 起動は `project` か `cwd` を要求する。

発言と返信は本社の Session フォーラムの投稿で中継する (2026-10-11 neco「スレッドではなく、フォーラムでやり取りしてほしい」)。
Session フォーラムの投稿内で実行したらその投稿、それ以外 (通常チャンネル・Session フォーラム外のスレッド) は Bot が Session フォーラムに
投稿を立てる (`SiteSpawnForum`、最初の本文は依頼者と依頼内容)。Bot が立てた投稿は forum 起動の対象外なので本社では起動しない。
投稿を作れなければ拠点へ渡さず理由を返す。フォーラムの無い構成 (forum mode off) だけ従来どおり受付返信からスレッドを作る。本社はスレッド → 拠点を
台帳に記録し、そのスレッドへの人の返信はタグが無くても拠点へ届ける (`routeIngress` が台帳を先に見る。名指し起動のスレッドも同じ)。
listener 停止中は本社で代わりに起動しない。

Session forum の起動 (`executeForumSpawn`) も、拠点タグ・名指しで決まらなかった投稿は関係プロジェクトの解決後に同じ担当拠点を引く
(2026-10-07 neco「入れる」)。担当が 1 拠点ならその拠点へ渡し (ランタイムルールタグも渡す)、複数なら不足情報の聞き返しと同じカードで
起動先 (担当拠点 + 本社) を選んでもらい、選択値を override として再開する。担当拠点へ渡せなければ本社で代わりに起動せず理由を返す。
部署フォーラム (部署の起動既定を拠点へ渡せない) と子会社 Bot は対象外。

### 拠点のタイトル印 (2026-10-10 neco 指示) {#SPEC-FED-SITE-TITLE-MARK}

「本社は各拠点ごとのフォーラムを持ちたい」「それかタイトルに[拠点名(1文字)]つける / タイトルの方がいいかな」。拠点ごとの
フォーラムは作らず、本社の Session forum のスレッド名に拠点の印を付けて見分ける (`src/federation/forum-site-routing.ts`)。

- 印は拠点の表示名 (無ければ site_id) の先頭 1 文字を大文字にした `[M]` の形 (`siteTitleMark`)。
- 本社が拠点へ渡したスレッド (拠点タグ・名指し・担当プロジェクト・`/spawn site:`) は、渡せた後にスレッド名の先頭へ印を付ける
  (`markSiteTitle`、すでに同じ印で始まれば付けない、100 文字で切る)。改名の失敗は warn だけで、起動の依頼は取り消さない。
- 題名の先頭が 1 文字の括弧 (`[M] ...`) で、その印が有効な拠点 1 つにだけ当たれば、その拠点で起動する (`resolveSiteFromTitleMark`)。
  名指し (「<拠点>で」/ `@<拠点>`) より先に見て、拠点タグがあればタグを優先する。頭文字が同じ有効拠点が複数あれば本社へ退避して warn する。
  `[Cc]` のような 2 文字以上の括弧は印として読まない。失効済みの拠点は印の照合に入れない。

### 拠点で起動したセッションを本社へ映す (2026-10-11 neco 指示) {#SPEC-FED-SITE-SESSION-MIRROR}

「MELPOT側のフォーラムでspawnしていた。本社側でも投稿できるようにしてほしい」。拠点が自分の Discord (拠点のフォーラム) で
起動したセッションは本社に投稿が無く、本社からは見ることも返信することもできなかった。拠点のセッションを本社の Session フォーラムへ映す。

| 責務 | 実装 |
|---|---|
| 依頼・応答のフレーム (`mirror-open-request` / `mirror-open-result`) | `src/federation/protocol.ts` / `hq-listener.ts` / `site-client.ts` |
| 本社: 投稿を立てて台帳に載せる | `src/federation/hq-session-mirror.ts` (Discord 実体は `bot.ts` が opener を注入) |
| 映した投稿の台帳 (本社 `<site>:<session>` / 拠点 `<session>` → 投稿) | `src/federation/session-mirror-store.ts` |
| 拠点: 映す判断・発言の転送・返信の注入 | `src/federation/remote-session-site.ts` / `remote-session-wiring.ts` |

1. 拠点: `session.started` で、起動元スレッド (`discord_source_channel_id`) を持ち、そのスレッドが本社から渡されたもの
   (スレッド台帳にある) ではないセッションだけを映す。題名は作業内容 → プロジェクト → 作業フォルダ名の順。本社自身 (拠点ロールでない Cc) は映さない。
2. 本社: 有効な拠点からの依頼だけ受け、Session フォーラムに Bot が `[拠点の印] 題名` の投稿を立てる。投稿はスレッド台帳
   (`federation.hq.remote_threads`) に拠点として記録する。これで拠点の発言 (egress) が通り、投稿への人の返信は既存の ingress 転送で拠点へ届く。
   同じセッションの再送には同じ投稿を返す。Bot が立てた投稿は forum 起動の対象外なので本社では起動しない。
3. 拠点: 返ってきた投稿を台帳 (`federation.site.session_mirrors`) とスレッド台帳に記録する。AI の発言は、本社から起動したスレッドが
   無ければ映した投稿へ返す。映した投稿への返信は、そのセッションが稼働中なら注入し、終わっていれば「準備中か終了」と返す。
4. 本社が断った・連合リンクが切れていたときは映さず warn だけ残す (セッション自体は拠点で動き続ける)。

拠点タグの候補: Villa から PC が取れれば従来どおり PC 名。取れない (Villa 停止・API 不一致) ときは
有効な拠点の表示名 (無ければ site_id、20 文字で切る) をタグにし、同じ名前で解決する
(`siteNameTagsOf` / `resolveSiteFromSiteNameTags`)。曖昧なら本社へ退避して warn する。

運用の前提 (人の設定): 本社の listener 有効化 (ポート・待ち受けアドレス)、各拠点 Cc の本社 URL・
拠点 ID・トークン。拠点側に別の Discord Bot を同じ guild へ繋いでいる構成は想定しない (二重投稿になる)。

### 日報は本社だけで更新し、拠点の作業は本社へ送る (2026-10-14 neco 指示) {#SPEC-FED-SITE-ACTIVITY}

「日報は本社のみで更新する / 各拠点がやったことは別途本社に送る処理を追加」「AとB両方」。拠点も本社と同じ Cc を動かしており、
日報の生成と LUDIARS ダッシュボードの日報 cron が拠点でも走っていた (拠点ごとに重複した PR、本社の日報に拠点の作業が載らない)。

| 責務 | 実装 |
|---|---|
| A: LUDIARS ダッシュボードの日報 (`ludiars-status-daily`) を拠点で発火しない | `src/scheduler/cron-jobs.ts` (`hqOnly`) / `cron-scheduler.ts` (`isSiteRole`) |
| B: 拠点では Cc の日報 (day_reports) を生成しない | `src/daily/scheduler.ts` (`isSiteRole`) |
| 拠点の作業記録の組み立て・本社の拠点欄の要約 (純関数) | `src/daily/site-activity.ts` |
| 送信フレーム (`activity-report`、拠点 → 本社、応答なし) | `src/federation/protocol.ts` / `hq-listener.ts` |
| 拠点: 今日・昨日の記録を 30 分ごとに送る | `src/federation/site-activity-reporter.ts` |
| 本社: 拠点・日付ごとの台帳 (後着で上書き、`federation.hq.site_activity`) | `src/federation/site-activity-store.ts` / `runtime.ts` |
| 本社の日報に拠点ごとの欄 (`bullets.sites`) | `src/daily/generator.ts` / `aggregator.ts` |

1. 拠点ロールかどうかは周期・発火のたびに見る (連合の設定は再起動なしで変わる)。拠点ロールでない Cc (本社・単独運用) の動作は変えない。
2. 拠点は今日と昨日のセッションを、新しい順に最大 80 件、題名・リポジトリ・ブランチ・provider・状態・開始/終了・時間と、提出した PR (下記) だけ送る。総数は別に送る。
   metadata・イベント本文・transcript は送らない。連合リンクが切れていれば送らず、次の周期で送り直す。
3. 本社は有効な拠点からの記録だけを保存し、同じ拠点・日付は後着で上書きする。失効・停止中の拠点の記録は日報に載せない。
4. 本社の日報は本社のセッションの集計とは別に、拠点ごとの欄を持つ (本社の session_count 等に拠点の数を混ぜない)。
   日報の再生成は従来どおり 4 時間の鮮度判定に従うので、拠点の記録が日報に入るまで最大 4 時間かかる。
5. 古い本社は `activity-report` を認証後の未知フレームとして読み捨てる (接続は切らない)。本社を先に更新する。

#### 提出した PR を含める (2026-10-14 neco 指示「拠点から送る記録に PR を含めますが、公開情報にする場合はチェックをかけます」)

上の未確定事項 (送る項目に提出した PR を含めるか) への回答。タスク: Actio `actio:1f93d2a7-733a-423d-9b97-492f8e0e660a`。

| 責務 | 実装 |
|---|---|
| セッションと PR の対応付け (純関数) | `src/daily/site-activity-prs.ts` (`indexSessionPrs`) |
| PR の項目・件数とバイトの上限 | `src/federation/protocol.ts` (`activityPrSchema` / `ACTIVITY_SESSION_MAX_PRS` / `ACTIVITY_REPORT_MAX_PRS` / `ACTIVITY_REPORT_MAX_BYTES`) / `src/daily/site-activity.ts` (`buildSiteDayActivity`) |
| 拠点: 送信時に PR を引く | `src/federation/site-activity-reporter.ts` (`listSessionPrs`) / `src/bootstrap/core.ts` |
| 本社: 拠点欄の PR (同じ PR は 1 件) | `src/daily/site-activity.ts` (`summarizeSiteActivity`) / `src/daily/generator.ts` |
| 受け入れ契約 (observe、Augur `site-activity-prs-C-1` / `C-2`) | `src/daily/site-activity-prs.contract.ts` / `site-activity-build.contract.ts` / `ontime-runtime.ts` |

1. 各セッションに、そのセッションが提出した PR を `prs` として載せる。項目は出所 (`local` = Revisor の local PR / `github` = Cc の PR 記録)・
   リポジトリ・番号・題名 (150 文字)・状態・URL (http(s) だけ。local PR は持たない) だけ。本文・差分・審査理由・CI の詳細は送らない。
2. セッションと PR の対応は Cc の既存の記録だけから取る。local PR は Revisor の提出元 `sessionId`、GitHub PR は `pr_records.author_session_id`。
   提出元が分からない PR は載せない。同じ PR (出所・リポジトリ・番号) は 1 件にし、新しい順にセッションあたり 5 件まで。
3. 上限: セッションあたり 5 件・1 報告あたり 120 件 (本社の検証で超えたら報告ごと拒否)。直列化した報告が 48KB を超えるときは、拠点が古いセッションから落として送る
   (本社の受信上限 64KB を超えると連合リンクごと切れるため。総数は `session_count` に残る)。
4. PR の取得に失敗したとき (Revisor 停止など) は PR なしで送る。作業記録の送信は止めない。
5. 後方互換: `prs` は任意項目。旧版の拠点 (PR を送らない) の報告も受け付け、拠点欄の PR は空になる。
   旧版の本社はセッションの未知項目を拒否するので、新しい拠点の報告は警告とともに読み捨てられる (接続は切れない)。本社を先に更新する。
6. 本社の日報の拠点欄 (`bullets.sites[].prs`) に、その拠点のセッションの PR を重複なしで載せる。template 版の日報にも PR の行を出す。

#### 公開時のチェック {#SPEC-FED-SITE-ACTIVITY-PUBLIC}

2026-10-14 時点の調査では、日報と拠点の記録が Cc の外へ公開される経路は無い。日報は `day_reports` に保存され、
loopback の `/v1/daily-reports` と Web UI だけが読む (Discord・Tabula・Memoria への投稿や公開 API は無い。Memoria・Tabula の
リポジトリにも `/v1/daily-reports` の利用は無い)。日報の本文生成で入力を claude CLI に渡すのは公開ではない。
`ludiars-status-daily` (LUDIARS ダッシュボードの日報) は Cc の日報・拠点の記録を読まない。

規則: 日報・拠点の記録 (特に拠点の PR) を Cc の外へ公開する経路を新たに作るときは、出す前に次を必須とする。

- 既存の漏洩チェック (公開リーク監査の登録語 = 秘匿語辞書 `.claude/state/confidential-terms.json`、AIFormat leak-checker と同じ形式) を
  題名・リポジトリ名・ブランチ名に通し、引っかかった項目は伏せる。
- 非公開リポジトリの PR は公開経路に出さない (公開かどうかを判定できないリポジトリも出さない)。
- 公開経路の実装は、この節に経路と判定の実装を追記してから行う。

### 本社と拠点で同じフォーラム投稿・通常セッションと同じ操作感 (2026-10-12 neco 指示) {#SPEC-FED-SITE-FORUM-PARITY}

「本社と拠点で同じフォーラムとして投稿されるようにしてほしい」「通常のセッションと同じDiscordでの操作感にする」
「メンションは起動したほうにつける」。`/spawn site:melpot` で起動したセッションの本社スレッドは、 拠点の発言が
"Concordia" 名義の文字だけで、 質問のボタンが無く、 誰にもメンションされなかった。 拠点のフォーラム投稿には
本社で書いた返信が出ず、 拠点で書いた返信は本社に出なかった。

- 価値: どちらの Discord から見ても同じ会話として読め、 いつもの操作 (ボタンで回答・返信で指示) ができる。
- 状態所有者: セッションと質問 (回答済みか) の正本は拠点。 本社は質問を保存せず、 スレッド台帳に起動者だけを持つ。
- 不変条件:
  - 拠点の AI 発言と質問は、 通常セッションと同じ webhook 名・アイコン (`buildDiscordWebhookIdentity`) で本社に出る。 名前を送らない古い拠点は従来どおり "Concordia"。
  - 質問は本社でも埋め込み + 選択肢コード付きボタン (5 択以下) / 選択メニュー (6 択以上・複数選択) のカードになる。
    押した回答は ingress の `answer` で拠点へ返り、 拠点は通常の回答処理 (`answerPendingQuestion`) で答える (拠点のカードも解決される)。
    回答済み・閉じた質問は拠点が断り、 本社スレッドへ理由を返す。 自由回答は投稿への返信で行う。 計画承認は送らない。
  - メンションは起動した側にだけ付く。 本社から起動したスレッドは、 本社がスレッド台帳の起動者 (`requesterId`) を
    メンションする (拠点はメンションを求めるだけで ID を送らない)。 拠点の Discord の質問カードは、 本社から起動したセッションでは依頼者をメンションしない。
    拠点で起動して映した投稿は起動者を持たないので、 本社ではメンションしない。
  - 本社で書かれた返信は、 拠点のセッションに注入すると同時に、 拠点のフォーラム投稿へ「<名前> (本社)」で出る。
    拠点の Discord で書かれた人の発言は「<名前> (<拠点>)」で本社へ出る。 本社から届いた返信の写しは本社へ送り返さない (注入 source で区別)。
  - 本社で書かれた返信には、 拠点のセッションがそれを読み込んだ (注入 source を持つ user 発言になった) 時点で、 本社のメッセージに ✅ が付く
    (通常セッションの inject ✅ と同じく、 届いただけでは付けない。 2026-10-12 neco「本社からメッセージ投稿した際にチェックマークがつかない」)。
    拠点は egress の `ack_message_id` で頼み、 本社は投稿せずにリアクションだけ付ける。 質問への回答 (ボタン) は対象外。

| 責務 | 実装 |
|---|---|
| egress の任意項目 (`username` / `avatar_url` / `mention_requester` / `question` / `ack_message_id`)・ingress の `answer` | `src/federation/protocol.ts` / `site-client.ts` / `remote-session-payload.ts` |
| 本社: 起動者の記録とメンション先の決定 | `src/federation/runtime.ts` / `remote-thread-registry.ts` (`requesterMentionFor`) |
| 本社: 名前・アイコン・メンション・質問カードの描画 | `src/discord/federation-egress.ts` / `federation-question.ts` |
| 本社: カードの回答を拠点へ返す | `src/discord/federation-question-interaction.ts` |
| 拠点: 名前付き発言・質問・人の発言の転送、 回答と本社返信の受け取り | `src/federation/remote-session-site.ts` / `remote-session-wiring.ts` / `remote-question.ts` |
| 拠点: 名前・回答・返信表示の注入 | `src/bootstrap/core.ts` |

復旧: 本社・拠点のどちらかが古い版でも、 知らない項目は読み捨てて従来の文字だけの中継に戻る。 両方を更新すれば揃う。 ただし拠点だけ新しいと、 古い本社は `ack_message_id` を読み捨てて "✅" を文字として投稿する (本社を先に更新する)。

### 本社の社員名簿の役職を拠点へ配る (2026-10-12 neco 指示) {#SPEC-FED-STAFF-ROLES}

「MELPOTのDiscordで権限が無いといわれるが権限はあるはず」→「本社の名簿を配る」。拠点の名簿は拠点の Discord に
触れた人を「ヒラ社員」で記録するだけなので、本社で管理職の人も拠点では `/end-session` が `session_end` 不足で拒否された。

- 状態所有者: 役職の正本は本社の社員名簿 (`staff_members`)。拠点は受け取った写しを `schema_meta` の
  `federation.site.hq_staff_roles` に置く (本体・chat worker・Discord のどのプロセスの `StaffRepo` からも読める)。
- 不変条件:
  - 本社は設定 (config-snapshot / config-update) に、役職を持つ人 (管理職・役員) の platform・ID・役職だけを載せる (`staff_roles`)。
    名前・メモ・アクセス時刻は渡さない。ヒラ社員は送らない (拠点の既定と同じ)。
  - 拠点の権限判定 (`StaffRepo.roleOf`) は、拠点の名簿と本社の役職の高いほうを使う。拠点の名簿で上げた役職は下げない。
    壊れた値・形の違う行は捨て、権限を与える側に倒さない。
  - 本社は名簿の役職が変わったら、つながっている有効な拠点へ設定を配り直す (設定の監視周期、既定 10 秒)。
    拠点はつながった時点で最新の設定を受け取り、オフライン起動時は前回の設定 (キャッシュ) の役職を使う。
  - 拠点ロールを外したら、本社の役職は権限判定に使わない (空にする)。
- 互換: 古い本社は `staff_roles` を送らず、拠点は本社の役職なし (従来どおり) で判定する。古い拠点は `staff_roles` を含む設定を
  形の違う設定として読み捨て (warn)、前回の設定のまま動く。両方を更新すれば揃う。

| 責務 | 実装 |
|---|---|
| 設定の `staff_roles` | `src/federation/protocol.ts` / `config-snapshot.ts` (`readHqStaffRoles`) / `config-cache.ts` |
| 本社: 変更時の配り直し・拠点: 受け取った役職の保存 | `src/federation/runtime.ts` |
| 役職の写しの読み書き・高いほうの判定 | `src/staff/hq-staff-roles.ts` / `src/db/staff-repo.ts` (`roleOf`) |
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
- `POST /v1/federation/inquiries` `{target, prompt, project?, timeout_sec?}` — 拠点間ワンショット調査
  (SPEC-FED-INQUIRY)。結果を待って `{ok, executed_by, output, error, duration_ms}` を返す。失敗は 502、
  不正な依頼は 400、連合未構成は 503。

## 拠点間ワンショット調査 (2026-10-11 neco 指示) {#SPEC-FED-INQUIRY}

依頼: 「連合で各拠点同士がワンショットで調査内容などを軽量に実行できるようにする」。
背景: MELPOT のセッションが起動しない件で、本社から MELPOT の Cc ログを読む手段が無く、原因の切り分けが
拠点の人に頼るしかなかった。セッション (スレッド・Lictor・Discord 中継) を立てずに、 1 回の問い合わせで
相手拠点の状態・ログ・コードを調べて答えだけ返す経路を足す。

- 価値: 拠点の中を、相手の人手を使わず 1 回の依頼で読み取って答えを得る。
- 不変条件:
  - 依頼を受けた側は `claude -p` を 1 回だけ、読み取り専用の道具 (Read / Grep / Glob と git の参照系 Bash) で動かす。
    起動先は `src/rules/claude-launch.ts` が決める (規則の実行 `claude-runner` と共通): PATH の `claude.exe` → npm 版の
    `claude.cmd` が指す `cli.js` を Node で直接 → ネイティブ版の既定位置。cmd.exe は挟まない
    (2026-10-11 MELPOT: npm 版しか無く `spawn claude.exe ENOENT` で調査も注入前の検査も動かなかった)。
    書き込み・Web・サブエージェントは `--disallowedTools` でも塞ぐ (`src/federation/inquiry-policy.ts`)。
  - 拠点同士は本社が中継する (拠点は本社にしか繋がっていない)。本社は依頼の origin を送信元拠点と照合し、
    結果は依頼を渡した宛先からのものだけ受け付ける (なりすまし・横取りの防止)。
  - 依頼・結果は outbox を使わない直接フレーム (`inquiry-request` / `inquiry-result`)。切断中は即失敗、
    結果不明は依頼元の期限切れで終わり、再送しない。古い Cc は未知フレームを読み捨てるので期限切れになる。
  - 実行は 1 拠点 1 本、待ち行列 3 本まで。超えたら busy で断る。期限は 30〜600 秒 (既定 300)、結果本文は 64,000 文字まで。
  - 作業ディレクトリは `project` を作業ルート配下で解決する (`..` 等は protocol で拒否)。無指定は最初の作業ルート。
  - 実行は Cc の one-shot 費用台帳に `kind: federation-inquiry` で記録する。

| 責務 | ファイル |
|------|---------|
| 判断 (振り分け・道具・期限・切り詰め) | `src/federation/inquiry-policy.ts` |
| 待ち合わせ (request_id → 結果、本社の中継表) | `src/federation/inquiry-broker.ts` |
| 手順 (本社 / 拠点どちらでも同じ入口) | `src/federation/inquiry-service.ts` |
| 実行 (claude -p、同時実行制御、費用記録) | `src/federation/inquiry-runner.ts` |
| フレーム | `src/federation/protocol.ts` (`inquiry-request` / `inquiry-result`) |
| 受け口 | `src/federation/hq-listener.ts` / `src/federation/site-client.ts` |
| 配線 | `src/federation/runtime.ts` (`requestInquiry` / `setInquiryRunner`)、`src/bootstrap/core.ts` |
| API | `src/api/federation.ts` (`POST /v1/federation/inquiries`) |

流れ (拠点 A → 拠点 B):

1. A の `POST /v1/federation/inquiries {target: "b"}` → A は本社へ `inquiry-request {origin: "a", target: "b"}`。
2. 本社は origin と接続元を照合し、B が有効・接続中なら中継表に記録して B へ渡す。そうでなければ理由付きの結果を A へ返す。
3. B は自分宛てなら実行し、`inquiry-result {executed_by: "b"}` を本社へ返す。本社は中継表から A を引いて返す。
4. 本社自身が宛先 (`target: "hq"`) なら本社が実行する。本社から拠点へは直接送る。

反映順: 本社と各拠点の Cc を更新するまで、その拠点への依頼は期限切れになる (既存の配備順に従う)。
人の画面 (Discord コマンド) はまだ無い。セッション・人は各拠点の loopback API を使う。

## イベント

`federation.site.connected` / `federation.site.disconnected` (site_id, ts) を
eventBus に emit。WebUI 拠点一覧 (`/federation`) の再取得トリガ。
