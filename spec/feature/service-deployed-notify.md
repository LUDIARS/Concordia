# デプロイ反映通知

Excubitor はサービスの hash が変化して健康状態へ戻った後、`POST /v1/events/service-deployed` を送る。Concordia は `(code,currentHash)` を一度だけ処理し、project registry の `deploy_notify` に指定された Discord、Slack、Cc 専用チャンネルへ通知する。

Revisor の repository / changes が未登録または利用不能でも、デプロイ反映そのものは通知する。本文は短縮 hash、version、merged PR 数、Revisor notice の先頭 10 行だけを用い、本文由来の mention は許可しない。

`service_deployment_ledger` は `(code,current_hash)` を所有し、同じ hash の再起動通知を一度だけ受理する。受理後の Revisor 取得または配送が失敗してもデプロイ事実を再実行扱いにはしない（CC-INV-03）。Revisor の repository ID と変更内容は Revisor API から都度取得し、Cc は git を直接読まない。

`deploy_notify` の `discord` と `slack` の `target` は名前付き webhook secret を指し、URL は project registry に保存しない。`cc-channel` は Settings の「デプロイ通知チャンネル」だけへ投稿し、session 用チャンネルへ混在させない。Discord の allowed mentions は常に空である。

## 本社・子会社の対象範囲

HQ 宛先（専用 Discord チャンネルと設定済み Discord/Slack webhook）はすべての project のイベントに含む。`project_codes.deploy_notify` はその project にだけ加える追加宛先である。`subsidiary_deploy_notify` は子会社ごとの `discord`、`slack`、`subsidiary-channel` 宛先を保存する。最後の種別は子会社固有の暗号化 bot token を復号して、target（空なら intake channel）へ `allowed_mentions: { parse: [] }` で送る。

子会社宛先は `subsidiary_projects` が project 名を含み、かつ `project_codes.revisor_workflow` のミラーが `revisor` の時だけ合成する。ミラーが `github` または null（Revisor 未登録・未確認）なら fail-closed で送らない。解決中の Revisor 照会は行わない。同じ webhook 名または同じ bot/channel 宛先は一度だけ配送する。
