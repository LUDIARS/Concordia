# Ergo パッケージ更新のお知らせを Concordia 経由でデプロイ通知チャンネルへ流す

- Actio: actio:2bb67449-6260-4c66-8d1e-e161016f53e7
- 仕様: [パッケージ更新のお知らせ](../feature/package-update-events.md)

## 目的

Excubitor (ergo-watch) が見つけた Ergo パッケージ更新のお知らせを、Concordia の Bot で本社のデプロイ通知チャンネルへ流す。

## 完了条件

- `POST /v1/events/package-updates` を `x-excubitor-token` 認可で受ける (認可なしは 401)。
- strict な本文 (`source`=`ergo-watch`、`runId` 1〜128 字、`messages` 1〜20 件、`text` 1〜1900 字、`private` bool) 以外は 400。
- `discord.deploy_notify_channel_id` 未設定は 503 `not_configured`。
- 各 text を順に投稿し、同じ (runId, 添字) は二度投稿しない。成功は 202 `{delivered, failed, duplicate}`。
- mention を無効化・無害化する。
- 認可・本文不正・未設定・重複・mention 無害化をテストで確かめる。

## 受け入れ契約

- C-1 handlePackageUpdates(event): 既に投稿済みの (runId, 添字) は投稿せず、全添字が投稿済みなら duplicate で配送 0 件を返す
- C-2 neutralizePackageUpdateText(text): 投稿本文に @everyone / @here / <@ / <# / <! / <:name: の mention 並びを残さない
