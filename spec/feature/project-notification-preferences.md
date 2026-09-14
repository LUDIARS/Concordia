---
type: feature
title: "プロジェクト別デプロイ・リリース通知設定"
description: "project registry の各プロジェクトに、デプロイ通知とリリース通知それぞれの有効/無効・本社宛て・子会社の範囲 (なし / 運用対象 / 全子会社 / 個別選択) を独立に持たせ、管理 UI のチェックボックスと選択式で編集する。未設定のプロジェクトは現行の配送規則を引き継ぎ、Ex/Cc/Pf/El/Rv/Di には指定の初期値を一度だけ入れる。"
service: concordia
domain:
  - service-deployed-notify
  - project-code-registry
status: implemented
updated: 2026-09-14
tags:
  - notification
  - deploy
  - release
  - subsidiary
---

# プロジェクト別デプロイ・リリース通知設定

2026-09-14 neco の設計指示。各プロジェクトにデプロイとリリースの独立した通知設定を設ける。

## 要件

- 各イベントについて通知の有効/無効、本社宛ての有無、子会社の範囲（なし・運用対象・全子会社・個別選択）を管理UIで選ぶ。複数の子会社を選択可能にする。
- JSON を直接入力させず、チェックボックスと選択UIで操作する。既存の追加Webhook宛先も名前を使って編集できる。
- 無効は本社や既定の子会社への通知も抑止する。リリース設定とデプロイ設定は相互に影響しない。
- 運用対象の子会社は既存の listDeployProjects の所属条件と有効な子会社から解決する。全体は本社＋全ての有効な子会社。個別選択も登録済み有効子会社のみを配送対象にする。
- 子会社の受付チャンネルと既存通知先を再利用し、秘密のWebhook URL・Bot tokenをプロジェクト設定APIへ返さない。
- 未設定の既存プロジェクトは現行の配送規則を引き継ぐ。新設定を保存した場合は明示設定を優先し、旧設定へ勝手にフォールバックしない。
- 本社・子会社・追加宛先の重複を除き、既存のイベント冪等性と通知失敗の記録を維持する。

## 設定モデル

`project_codes` はイベントごとに 1 列ずつ明示設定を持つ。

| 列 | イベント | 未設定 (NULL) のとき |
|---|---|---|
| `deploy_notification` | `service.deployed` | [デプロイ反映通知](service-deployed-notify.md) の現行規則 |
| `release_notification` | Release 公開 | [公開リリース通知](release-published-notify.md) の現行規則 |

値は `{ "enabled": boolean, "hq": boolean, "subsidiary_scope": "none" | "operating" | "all" | "selected", "subsidiary_ids": string[] }` の JSON。`subsidiary_ids` は `selected` のときだけ保持し、他の範囲では保存時に空へ正規化する。列を分けるので、片方のイベントを保存してももう片方は未設定のまま残る。

## 宛先の解決（不変条件）

明示設定を持つイベントは次の範囲だけへ配送し、旧規則（本社は無条件・子会社は Revisor workflow ミラー必須）へ戻さない。

- **無効**（`enabled: false`）は本社・子会社・追加宛先のいずれにも送らない。イベント台帳の claim は従来どおりで、再送しても配送を試みない。
- **本社**（`hq`）は既存の本社宛先（デプロイ: 専用チャンネルと設定済み Discord/Slack webhook、リリース: リリース通知チャンネル）を含めるかだけを決める。
- **追加宛先**（`deploy_notify`）はデプロイ通知が有効なときだけ加える。リリースには従来どおり使わない。
- **子会社の範囲**
  - `none` — 子会社へ送らない。
  - `operating` — 有効な子会社のうち、通知対象 project（`listDeployProjects` / `subsidiary_deploy_projects`）にこの project を含むもの。
  - `all` — 有効な全ての子会社。
  - `selected` — 選んだ ID のうち、登録済みで有効な子会社だけ。無効化・削除された子会社には送らない。
- 子会社への宛先は受付チャンネルと登録済みの通知先（`subsidiary_deploy_notify` の有効な行）を再利用する。追加通知先が未登録でも、明示設定で選ばれた子会社には受付チャンネルへ配送する。同じ受付を登録通知先にも含む場合は重複を除く。
- 明示設定では子会社 Bot 未設定の子会社チャンネルも宛先に残し、配送時に本社 Bot で投稿する（`resolveSubsidiaryBotToken`）。未設定プロジェクトの現行規則は変えない。
- 利用者が範囲を選んだことを認可とみなし、明示設定では Revisor workflow ミラーで子会社を絞らない。
- 本社・追加宛先・子会社の宛先は物理的な宛先単位で重複を除く。イベントの冪等性台帳と宛先ごとの `delivered` / `failed` の記録は変えない。
- 保存値が読めない（壊れた JSON・未知の範囲）ときは無効として扱い、旧規則へ黙って戻さない。

## 管理 API

`GET /v1/project-codes/admin` の各 entry に `deploy_notification` / `release_notification` を `{ configured, enabled, hq, subsidiary_scope, subsidiary_ids }` で返す。`configured: false` は未設定で、他の値は現行規則（本社＋運用対象の子会社）を表す表示用の値。一覧の `subsidiaries` は `{ id, name, enabled }` だけで、Bot token・Webhook URL などの秘密は返さない。

`PATCH /v1/project-codes/:code` は `deploy_notification` / `release_notification` を個別に受け取り、省略したイベントの保存値は変えない。`selected` の ID に未登録の子会社があれば `404 subsidiary_not_found`、子会社 registry が無ければ `503 subsidiary_registry_unavailable` を返して保存しない。

## 管理 UI

プロジェクトコード一覧の「通知」列にデプロイ / リリースの要約を出し、「通知設定」で行の下に編集欄を開く。イベントごとに「通知する」「本社へ送る」のチェックボックスと子会社の範囲の選択を並べ、個別選択では登録済み子会社をチェックボックスで複数選ぶ（無効な子会社は無効と表示し、登録から消えた ID は外すことだけができる）。

追加宛先は、設定ページ「デプロイ通知」に名前で登録した webhook（`discord` / `slack`）と Cc デプロイ通知チャンネルをチェックボックスで選ぶ。選択肢に無い旧設定の名前は外すことだけができる。JSON は入力させない。

保存は触ったイベントだけを送る。未設定のイベントは、触って保存した時点で現行規則と同じ値でも明示設定になる。

## 指定された初期設定

| code | project | リリース | デプロイ |
|---|---|---|---|
| Ex | Excubitor | 本社のみ | なし |
| Cc | Concordia | 本社のみ | 本社＋運用対象の子会社 |
| Pf | Praeforma | 本社＋子会社 | なし |
| El | Elegantia | 本社＋全子会社 | 本社＋全子会社 |
| Rv | Revisor | 本社＋全子会社 | 本社＋運用対象の子会社 |
| Di | Discutere | 本社＋全子会社 | 外部通知なし（ローカル通知化） |

「本社のみ」は `enabled: true, hq: true, subsidiary_scope: "none"`、「なし」「外部通知なし」は `enabled: false`。Pf の「子会社」は運用対象として扱う。ユーザーから範囲の訂正があれば管理 UI で保存する。Di のローカル通知化はこの機能の範囲外で、別途扱う。

migration 108 がこれらの値を既存登録へ一度だけ適用する。code（大文字小文字を区別）と project 名（区別しない）の両方が一致し、列が未設定の登録にだけ書くので、別プロジェクトへ適用せず、後から管理 UI で保存した変更も上書きしない。新規 DB の registry は空で始まり、初期値は登録を作らない。初期値の表は migration の source に含めて checksum で凍結する。

## 実装の配置

| ファイル | 役割 |
|---|---|
| `src/deploy/notification-target-policy.ts` | 保存値の解釈・正規化と子会社範囲の判定（純関数） |
| `src/deploy/deployment-targets.ts` | 未設定時の現行規則と明示設定の宛先解決・重複排除 |
| `src/deploy/subsidiary-notification-candidates.ts` | 明示設定では受付チャンネルも含めた子会社候補の取得 |
| `src/deploy/service-deployed-runtime.ts` / `src/deploy/release-published-runtime.ts` | イベントごとの列を読み、宛先解決へ渡す |
| `src/db/project-notification-seed.ts` | 指定初期値と一度だけの適用 |
| `src/db/schema.ts` / `src/db/migration-ledger.ts` | migration 108、凍結台帳、スキーマ指紋 |
| `src/db/project-codes-repo.ts` | 列の読み書き |
| `src/api/project-notification-preferences.ts` / `src/api/project-codes.ts` | 入力検証・表示形・秘匿 |
| `web/src/project-notification-settings.ts` / `web/src/pages/ProjectNotificationSettings.tsx` / `web/src/pages/ProjectCodes.tsx` | 管理 UI |

## 検証

通知の無効、各宛先範囲、イベント間独立、既存値保持、指定初期値、秘匿・重複排除を次のテストで扱う: `notification-target-policy.test.ts`、`deployment-targets.test.ts`、`service-deployed-runtime.test.ts`、`project-notification-seed.test.ts`、`project-codes-repo.test.ts`、`project-codes-admin.test.ts`、`project-notification-settings.test.ts`。テスト実行・デプロイ・再起動は別途許可範囲に従う。
