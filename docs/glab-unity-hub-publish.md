# GLab-UnityHub の公開手順 (Cloudflare Tunnel、 Access なし)

GLab-UnityHub (Excubitor code `concordia-glab-unity-hub`) を GLab のメンバーの Unity から使えるようにする手順。
仕様は [spec/feature/glab-unity-hub.md](../spec/feature/glab-unity-hub.md)。

> **この手順の実行 (公開ホスト名・DNS の作成、 サービスの起動、 実 Discord / Notion / GitHub への書き込み) は、
> 人の許可を取ってから親セッションが行う。** 実装の委託では設定値・catalog・この手順書までを用意している。

## 0. 前提

- Hub は **loopback (127.0.0.1) でだけ待ち受ける**。 外から届くのは Cloudflare Tunnel 経由だけ。
- Cloudflare Access は **付けない**。 Unity (`ClientWebSocket`) は Access のログインを通れないため、
  認証は Hub のトークン (`/glab-unity-token` で本人が発行) だけで守る。
- 海外監視は Cloudflare が付ける `CF-IPCountry` / `CF-Connecting-IP` を使う。 Tunnel を通らない直結
  (CF ヘッダ無し かつ 送信元が loopback 以外) は Hub が拒否する。 loopback からの直結は開発用に通る。
- 既定の方針は `block` (許可国 JP 以外は 4403 で切断、 neco へ Discord DM で通知)。

## 1. Portus を用意する

Hub の HTTP / WS は Portus (`@ludiars/portus`) を使う。 依存としての取り込み (submodule + package.json) は
外部取り込みの検査記録が必要なため、 この変更には含めていない。 どちらかで用意する:

1. **推奨 (取り込み後)**: 検査記録を作り、 `lib/portus` に submodule を追加して `"@ludiars/portus": "file:lib/portus"` を
   package.json に足し、 `npm run bootstrap` で build する。
2. **当面**: LUDIARS の Portus checkout を build し、 `.env` に `GLAB_UNITY_HUB_PORTUS_ROOT=<Portus の checkout>` を書く
   (`<root>/dist/http/index.js` と `<root>/dist/ws/index.js` を読む)。

Portus が見つからなければ worker は理由を出して起動しない (別の WS 実装へは落ちない)。

## 2. 設定

`concordia.config.json` に `glabUnityHub` 節を書く (例は `concordia.config.example.json`)。 秘密はここに書かない。

| 項目 | 内容 |
| --- | --- |
| `guildId` | GLab の Discord サーバー id。 `/glab-unity-token` はこの guild にだけ登録される |
| `publicHostname` | 手順 4 で作る公開ホスト名 (表示用) |
| `allowedCountries` / `geoPolicy` | 既定 `["JP"]` / `block`。 env `GLAB_UNITY_HUB_ALLOWED_COUNTRIES` / `GLAB_UNITY_HUB_GEO_POLICY` で上書き |
| `notifyUserId` | 海外接続を知らせる相手 (neco) の Discord ユーザー id |
| `bugReportChannelId` | Melpomene のログを添付で上げるチャンネル |
| `notionBoards` | 扱ってよい Notion ボード (id・name・dataSourceId・credentialKey・プロパティ名) |
| `melpomeneRepos` | Melpomene が Issue を作ってよい repo |
| `specRepos` | PR から仕様下書きを作る repo と Praeforma のプロジェクト |
| `projects` | Hub で扱うプロジェクト (Breviarium / Actio / Praeforma / 本体 checkout の対応) |
| `actioUsers` | Discord ユーザー id → Actio ユーザー id (スプリントのタスクは担当本人だけが変えられる) |

鍵の置き場:

- Discord Bot token: Concordia の Discord 設定 (DB 優先、 env `CONCORDIA_DISCORD_TOKEN`)。 Hub は Bot と同じ token で別の gateway に入る。
- Notion: env `CC_NOTION_TOKEN_<credentialKey>` (既存の Concordia の Notion 連携と同じ)。
- GitHub: `gh auth` (Unity にトークンは渡さない)。
- Actio: 既存の `CONCORDIA_ACTIO_TASK_BINDINGS` (または Excubitor 注入設定)。

PR フック (4d) は既存の GitHub webhook 受け口 `POST /v1/github/webhook` を使う。 対象 repo に repo 個別の webhook secret を
設定し、 `Pull requests` イベントを送る。 GitHub 側の webhook の向き先は Concordia 本体 (Hub ではない)。

## 3. 起動 (Excubitor 経由)

- catalog: `excubitor.catalog.yaml` の `concordia-glab-unity-hub` (port 11115、 `autostart: false`)。
- `npm run build` 後、 Excubitor から起動する (cc-test の claim → 起動 → release)。 `GET http://127.0.0.1:11115/health` が
  `{"ok":true,...}` を返せば待受できている。
- loopback での疎通確認 (CF ヘッダ無し): Unity の `Foundation/GLab Hub` → セットアップに `ws://127.0.0.1:11115/v1/glab-unity/ws`
  とトークンを入れて接続テスト → `hub.whoami` が返る。

## 4. Cloudflare Tunnel の公開ホスト名

1. Cloudflare Zero Trust → Networks → Tunnels で、 この PC の既存 Tunnel (無ければ作成) を開く。
2. **Public Hostname** を追加:
   - Subdomain / Domain: 例 `glab-unity-hub.<自分のドメイン>` (`glabUnityHub.publicHostname` と揃える)
   - Service: `HTTP` / `127.0.0.1:11115`
   - Additional settings → HTTP Settings: `HTTP Host Header` は空のまま。 WebSockets は有効 (Cloudflare 側の既定)。
3. **Access アプリケーションは作らない** (このホスト名に Access ポリシーを掛けない)。
4. 必要なら WAF でこのホスト名へのレート制限を足す (Hub 側にも毎分 60 要求・投稿 10 件の制限がある)。

Unity 側の接続先は `wss://glab-unity-hub.<自分のドメイン>/v1/glab-unity/ws`、 Melpomene は
`https://glab-unity-hub.<自分のドメイン>/v1/glab-unity/melpomene/reports`。

## 5. 公開後の確認

- 許可国からの接続で `hub.whoami` が返る。 監査 (`glab_unity_audit`) に `ws.auth ok` が残る。
- `/glab-unity-token revoke <識別子>` のあと、 接続中の Unity が数秒以内に 4401 で切れる。
- 許可国外 (VPN 等) からの接続が 4403 で切れ、 neco に DM が届く (同じトークン・同じ国は 1 時間 1 回)。
- Tunnel を通さずに LAN の IP から直接つなぐと拒否される。

## 6. 止める・戻す

- Excubitor から `concordia-glab-unity-hub` を停止する。 Bot の `/glab-unity-token` は残るが、 Unity からは繋がらなくなる。
- 公開をやめるときは Tunnel の Public Hostname を消す。 発行済みトークンはモジュール DB (`glab-unity-hub.sqlite`) に
  ハッシュだけが残る。 全員分を無効にするときは各自 `revoke`、 または DB の `revoked_at` を埋める。
