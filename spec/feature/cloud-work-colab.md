---
id: CC-CLOUD-COLAB
title: 本人同席の一般版 Colab 実行
status: draft
domain: cloud-execution
---

Actio `actio:cf6b45c9-6e28-47c1-b030-7cad7d551ffa`、`actio:3acee90b-4ce3-4d2f-b30b-34da85ba67e5`。UX-CC-W2/W3/W4/W5、UX-CC-S2/S3/S4/S5/S6、CC-INV-02/03/04/07/08。

## 所有する状態と操作

Cc の cloud-execution は開始承認、依頼指紋、受付、観測、回収、解放の観測を記録する。Actio はタスク、所有者は品質検収、Excubitor の Colab 拠点はジョブとランタイムの割当、停止、解放を所有する。

- CC-CLOUD-COLAB-01: 認証済み本人の明示開始、公開コード、非機密データ、本人の許可先、予算・使用量上限、期限を必須とする。登録済み固定 revision、SHA-256、GPU を使用し、同時実行は全登録を通じて 1、同一依頼の試行は 1 とする。Colab は自動選択・batch の対象外。
- CC-CLOUD-COLAB-02: 投入前に冪等キー・期限・依頼指紋を台帳に保存し、受付時に拠点のジョブ ID を同じ台帳に記録する。以後の観測ではその ID を使う。Excubitor の現行 API は冪等キーによる読取を提供せず、同一キーでの POST は未受付の場合に新規起動する。応答を失った場合は再送を止め、冪等キーを表示して所有者の照合を待つ。Cc からの照合再開には Excubitor 側でキーに対応する受付を読み取れる経路が必要。
- CC-CLOUD-COLAB-03: 提供元の実行結果、worker 申告、成果の整合性、品質検収、解放を独立に記録する。拠点の receipt と回収 manifest が一致し、`cc-result.json` と各登録ファイルのサイズ・SHA-256 が合い、報告の試行キーと revision が一致することを検証する。小さい報告を保存し、それ以外は検証済みの名前・サイズ・ダイジェストを記録する。大型チェックポイントは既存の Drive 返送を使う。
- CC-CLOUD-COLAB-04: 停止要求は台帳に保存し、同じジョブ ID に送る。停止を確認するのは拠点の結果が `cancelled` で `released` の場合だけ。`release_unknown` は枠を保持し、所有者に Colab のランタイム管理画面での確認を案内する。Cc の停止後も期限と解放を拠点が担当し、再起動時は受付済みジョブの観測を再開する。
- CC-CLOUD-COLAB-05: WebUI で拠点への接続準備と失敗理由を表示する。状態 API の認証済み `colab_job_missing` を読取経路の確認に使い、Colab CLI のログイン確認は開始時に拠点が行う。メッシュ未構成や応答未確認のときは状態を示し、通信エラーの直後から利用者の明示更新まで自動照会を止める。

## 既定の拠点 transport

`CONCORDIA_CLOUD_CONFIG_FILE` の Colab target に `provider: colab` と固定 `sourceRevision` (40 桁) を指定する。`transferMode` の既定は `excubitor-site`。`colab` に `ownerId`、`organizationId`、`destination`、`code: public`、`data: non_confidential`、`programSha256`、`maxSeconds`、`usageUnitsPerMinute`、`maxUsageUnits` と `site: { peerId, programId, gpu, outputNames }` を設定する。`outputNames` は拠点に登録した小容量の出力名と一致させる。

本社 Excubitor の `hq.sitePeerId` を同じピア ID にし、拠点間認証 cr-v1、拠点の Colab CLI、所有者、登録プログラム、固定 revision、SHA-256、GPU を準備する。Cc は本社の loopback 管理 API のサービス情報と `/health` で接続先を確かめる。Colab のログインは GROMAC の OS アカウントで行う。拠点準備手順は Excubitor の `spec/feature/colab-site-runner.md` と Ars の `spec/plan/2026-11-21-gromac-mesh-auth-and-colab-runbook.md` を参照する。

| 共通操作 | 本社 Excubitor `/api/v1/colab/peers/:site/jobs` |
| --- | --- |
| submit | `POST`。キー、所有者の明示開始、登録プログラム、revision、SHA-256、GPU、期限と公開区分を送る |
| reconcile / observe | 受付済みは `GET /:id` で照合。ジョブ ID が不明な場合は CC-CLOUD-COLAB-02 に従う |
| cancel | `POST /:id/cancel`。応答不明時は同じ ID の状態を読む |
| collect | `POST /:id/collect` で manifest を読み、ファイル名を指定してバイトを取得する |
| release | 拠点の receipt の `phase` を観測する |

拠点の `CC_CLOUD_INPUT` は `attemptId` (Cc の冪等キー)、`sourceRevision`、空の `uploads` を含む。固定プログラムは `/content/cc-result.json` に `version: 1`、`attemptId`、`sourceRevision`、`exitCode`、`tests: { total, failed, skipped }` または `metrics` と、登録出力の `checkpoints: [{ name, bytes, sha256 }]` を書く。拠点の上限は報告 128 KiB、成果物 16 MiB × 8 件。大型チェックポイントは別名で Drive の限定フォルダに返し、既存の Drive manifest (`result.json`) と `ccTarget` / `ccAttempt` / `ccName` で照合する。登録済みプログラム側でアップロード経路を準備し、Cc からファイルとアプリ専用の `appProperties` を読める Drive クライアントを使う。Cc は任意の `drive: { credentialRef, folderId, checkpointNames }` により回収時の照合だけを行う。

## 明示的な HQ REST + Jupyter transport

`transferMode: jupyter` を明記すると旧経路を使用する。`colab` に `credentialRef`、相対パス `program` と `runtimeSpec` を指定する。既存の稼働・履歴レコードは保存時の登録と方式で扱う。切替・復旧では台帳を保ち、旧方式の未解放ジョブを元の資格で照合する。拠点の利用を止める場合は新規受付用の target を外し、台帳と拠点側の結果を保つ。

資格情報は用途別に設定する。`cloud_work.oauth.<SHA-256>` のハッシュ対象は UTF-8 の `[organizationId, ownerId, purpose, credentialRef]` の JSON 配列。保護された Cc 設定ストアに `clientId`、`clientSecret`、`refreshToken` を登録する。`purpose: colab` は明示的に選んだ Jupyter 経路でのみ使い、`purpose: drive` は任意の Drive 照合に使う。Jupyter では従来どおり `uploads` がファイル単位の Drive 返送先を含み、実行時のみ Colab OAuth 資格を使う。

`/v1/delegation/cloud/colab` の `/targets`、`/runs`、`/runs/:id/stop`、`/runs/:id/collect`、`/runs/:id/quality` は Cernere の WebUI 本人 ID と組織 ID を使用する。書き込みは同一オリジンのブラウザー操作に限る。`GET /runs?refresh_site=1` は保存済み受付 ID の状態を明示更新する。拠点・プラン・GPU・実際の回収はデプロイ時に確認する。

## 受け入れ契約

```text
C-38 siteJobEvidence(receipt, stopRequested): 拠点が解放を確認するまで枠を保持し、停止要求と停止確認を区別する
C-39 verifySiteArtifact(bytes, expected): 上限内でサイズと SHA-256 が一致する成果物だけを受け入れる
C-40 siteJobAction(state, initial): 受付不明を再送せず、保存済みの受付 ID だけを観測や停止に使う
```
