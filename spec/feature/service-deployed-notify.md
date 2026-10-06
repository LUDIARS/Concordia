# デプロイ反映通知

Excubitor はサービスの hash が変化して健康状態へ戻った後、`POST /v1/events/service-deployed` を送る。Concordia は `(code,currentHash)` を一度だけ処理し、project registry の `deploy_notify` に指定された Discord、Slack、Cc 専用チャンネルへ通知する。

Revisor の repository / changes が未登録または利用不能でも、デプロイ反映そのものは通知する。本文は短縮 hash、version、merged PR 数、Revisor notice の先頭 10 行だけを用い、本文由来の mention は許可しない。

`service_deployment_ledger` は `(code,current_hash)` を所有し、同じ hash の再起動通知を一度だけ受理する。受理後の Revisor 取得または配送が失敗してもデプロイ事実を再実行扱いにはしない（CC-INV-03）。Revisor の repository ID と変更内容は Revisor API から都度取得し、Cc は git を直接読まない。

`deploy_notify` の `discord` と `slack` の `target` は名前付き webhook secret を指し、URL は project registry に保存しない。`cc-channel` は Settings の「デプロイ通知チャンネル」だけへ投稿し、session 用チャンネルへ混在させない。Discord の allowed mentions は常に空である。

公開済み Release の通知は [公開リリース通知](release-published-notify.md) が所有する。`service.deployed` の台帳・配送先とは別のイベントであり、同じ専用チャンネルを暗黙に共用しない。

## Concordia 自身の配備

2026-10-06 neco 指示「デプロイの通知は GLab にも飛ばそう」。GLab の通知先と対象 (Concordia) は設定済みだったが、Concordia の配備は
台帳に 10/01 の 2 件しか無かった。Excubitor は再起動の直後に `/v1/events/service-deployed` を呼ぶが、Concordia 自身の再起動では
その瞬間に Concordia がまだ起動しておらず、通知が抜け落ちていた。

- Concordia は起動 15 秒後に 1 回、自分の版 (`git rev-parse --short=12 HEAD`) を台帳の直前の版 (`latestHash("concordia")`) と比べ、
  変わっていれば `handleServiceDeployment` を同じ宛先で流す (`src/deploy/self-deployment.ts`)。
- 台帳が同じ版を 1 回しか受け付けないので、Excubitor の呼び出しが届いても二重には送らない。版が取れない・台帳に記録が無いときは何もしない。
- 未解決 (Concordia の外): 2026-10-05 21:49 (UTC) 以降、どのサービスの service.deployed も台帳に届いていない。Excubitor 側の確認が要る。

## 本社・子会社の対象範囲

この節の規則は、デプロイ通知の明示設定を持たない project（`project_codes.deploy_notification` が NULL）に適用する。明示設定を保存した project は [プロジェクト別デプロイ・リリース通知設定](project-notification-preferences.md) で選んだ範囲だけへ配送し、この節の規則へ戻さない。リリース通知の設定はデプロイの宛先に影響しない。

HQ 宛先（専用 Discord チャンネルと設定済み Discord/Slack webhook）はすべての project のイベントに含む。`project_codes.deploy_notify` はその project にだけ加える追加宛先である。`subsidiary_deploy_notify` は子会社ごとの `discord`、`slack`、`subsidiary-channel` 宛先を保存する。最後の種別は子会社固有の暗号化 bot token を復号して、target（空なら intake channel）へ `allowed_mentions: { parse: [] }` で送る。

子会社宛先は `subsidiary_projects` が project 名を含み、かつ `project_codes.revisor_workflow` のミラーが `revisor` の時だけ合成する。ミラーが `github` または null（Revisor 未登録・未確認）なら fail-closed で送らない。解決中の Revisor 照会は行わない。同じ webhook 名または同じ bot/channel 宛先は一度だけ配送する。

## 通知対象プロジェクト (関係プロジェクトとは別定義)

子会社への配送判定は `subsidiary_deploy_projects` (通知対象 project) で行い、`subsidiary_projects`
(関係 project = Test forum / spawn / 受付ゲートの範囲) は使わない (neco 2026-09-12)。通知だけ受けたい
project を関係 project に足すと Test forum 等まで開いてしまうため。`PUT /v1/subsidiaries/:id/deploy-notify-projects`
`{ "projects": [...] }` で置き換え、子会社詳細に `deploy_notify_projects` を同梱する。未設定 (空) の子会社には
配送しない。子会社 Bot トークンが未設定の場合は本社 Bot で投稿する (`resolveSubsidiaryBotToken`)。
