# 公開リリース通知

Revisor は major/minor Release の公開後、同じ loopback dispatch 認可で `POST /v1/events/release-published` へイベントを送る。Concordia は `release_notice_ledger` が所有する `(repository, tag)` を先に claim し、再送で同じ Bot 投稿を増やさない（CC-INV-03）。

宛先は設定 `discord.release_notify_channel_id` の HQ チャンネルと、**対象プロジェクトを担当する子会社チャンネル**。解決は `resolveDeploymentTargets` に委ね、HQ は無条件、子会社は project scope と Revisor workflow の両方が揃ったときだけという fail-closed の規則をデプロイ通知と 1 か所で共有する（CC-INV-06）。リリースだけ緩い経路を作らないためで、判定を二重に持たない。

**プロジェクト個別の `deploy_notify` には振り分けない。** あれは「反映した」を知らせる宛先で、「公開した」の宛先とは別物。混ぜると、デプロイ通知だけを受けたい webhook にリリースまで流れる。

宛先が 1 つも解決できなければ配送を試みず、受理済みとして 202 とログを返す。本文は `【repository tag リリース】 title`、notice の先頭 10 行、Release URL で構成する。Bot 投稿は `allowed_mentions: { parse: [] }` を必ず使い、notice を mention として解釈させない（CC-INV-06）。Bot 失敗はログと応答で観測可能にするが、Release の公開結果を巻き戻さず、同じ台帳 key の再実行もしない。配送結果は宛先ごとに `delivered` / `failed` として残す。宛先が複数になったので、1 件でも落ちていれば残りが届いていても warn に出す — 子会社だけ届いていない状態を「配送完了」に埋めない。

## 宛先の読み出し

設定 API は Discord store の値を種類を問わず暗号化して保存する。 チャンネル ID は秘密ではないが
同じ経路を通るため暗号文で残る。 配送側は必ず復号して使う (`readDiscordSetting`)。
暗号文をそのまま ID として投げると Discord が 404 を返し、 チャンネル不在や権限不足と
区別できない障害になる。 復号できない値は未設定として扱い、 壊れた ID で投稿を試みない。
この規則はデプロイ通知 (`deploy_notify_channel_id`) と新規プロジェクト通知にも同じく適用する。

子会社への配送判定はデプロイ通知と同じく通知対象 project (`subsidiary_deploy_projects`) を使う。
関係 project (`subsidiary_projects`) は通知の判定に使わない。
