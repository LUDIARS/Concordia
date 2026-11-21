---
id: CC-CLOUD-AWS
title: Excubitor 経由の AWS 計算ジョブ
status: draft
domain: cloud-execution
---

Actio `actio:3acee90b-4ce3-4d2f-b30b-34da85ba67e5`。UX-CC-W2/W3/W4/W5、UX-CC-S2/S3/S4/S5/S6、CC-INV-02/03/04/07/08。

Cc は人間による承認、依頼指紋、受付と回収の台帳を所有する。Excubitor は登録先と runner、AWS 資格、ジョブの観測・停止・解放を所有する。Actio はタスク、依頼者は品質検収を所有する。

- CC-CLOUD-AWS-01: Cernere の本人・組織とリポジトリ・子会社の登録が一致する WebUI で、公開コード、非機密入力、登録済み送信先と期限を確認して開始する。MCP は同じセッションに開始案を置き、WebUI の本人が内容を確認して開始する。既存の予算・子会社枠・人間回答待ちのゲートと、実行先ごとの最大時間・見積使用量上限を適用する。標準クラウドの自動選択とバッチの対象外。
- CC-CLOUD-AWS-02: 1 実行先に未解放の依頼は 1 件、同じ依頼の投入は 1 回。Cc は外部副作用の前に受付意図と冪等キー（Ex の `job_id`）を永続化する。Ex には登録された対象 ID、runner、非秘密の入力、絶対期限を送る。応答を失った場合はジョブ一覧をページ単位で読み、同じキー・対象・runner の受付を照合する。見つからなければ未確認を維持し、占有枠を保持する。
- CC-CLOUD-AWS-03: `observe` は Ex の operation ID で取得する。Fargate の終了コードは登録 runner コンテナの観測値を使う。EC2 では終了コードが Ex に無く、終了と解放だけでは実行成功を判定しない。停止は `POST /jobs/:id/cancel` の要求と後続の終端確認を分ける。`release` は Ex の confirmed / not_allocated を根拠とする。期限による停止は Ex が担う。
- CC-CLOUD-AWS-04: Ex のジョブ API は成果物を返さない。任意の Drive 返送を登録し、runner は固定のフォルダに attempt ID に対応する出力と `result.json` を格納する。Cc は小さい manifest と Drive のサイズ・SHA-256 の一致を確認し、URI、サイズ、digest を記録する。出力本体は Drive に保持する。provider の状態、worker 報告、整合性、品質、解放は独立する。

## 受け入れ契約

```text
C-35 awsAdmission(input): 本人承認・区分・登録先・期限・使用量上限を満たす場合だけ受理する
C-36 matchAwsJob(jobs, identity): 同じ冪等キー・実行先・runner の一意な受付だけを照合する
C-37 awsJobEvidence(job, container): 停止要求・解放・登録コンテナの終了コードを独立に記録する
```

検証は偽 Ex transport、固定時刻、テスト用台帳を使う。承認・予算不足、二重開始、対象別の占有、応答喪失と再起動後の照合、停止要求と後続の解放、成果の回収・検収の分離、WebUI/MCP の境界を対象とする。

## 管理者の登録と復旧

1. Excubitor の「AWS 計算」に EC2 または Fargate の実行先と runner を登録する。共有 Vault に `EX_AWS_COMPUTE_ACCESS_KEY_ID`、`EX_AWS_COMPUTE_SECRET_ACCESS_KEY` と必要に応じて `EX_AWS_COMPUTE_ROLE_ARN`、`EX_AWS_COMPUTE_SESSION_TOKEN`、`EX_AWS_COMPUTE_EXTERNAL_ID` を登録する。IAM、AMI / タスク定義、期限と残存資源の条件は Excubitor の `spec/feature/aws-compute.md` に従う。
2. Cc の管理者設定 `CONCORDIA_CLOUD_AWS_CONFIG_FILE` に、下記の形式の JSON 配列を格納したローカルファイルを指定する。対象と runner は Ex の登録 ID。本人 ID と組織 ID は Cernere の値、`subsidiaryId: null` は本社を表す。見積使用量は「実行秒数 × 1 分の使用量 ÷ 60」で、実際の AWS 請求は運用者が確認する。

```json
[{
  "repoPath": "E:/Document/Ars/example",
  "subsidiaryId": null,
  "ownerId": "cernere-user-id",
  "organizationId": "cernere-organization-id",
  "targetId": "registered-ec2",
  "runner": "build",
  "destination": "approved-output",
  "maxSeconds": 300,
  "usageUnitsPerMinute": 1,
  "maxUsageUnits": 5
}]
```

Cc の通信先は loopback の Ex 管理 API。既存の Ex 接続設定から discovery を行い、`excubitor` の実効ポートをカタログの情報で解決し、`GET /health` でサービスを確認する。API 呼び出しは明示操作で行う。Cc から AWS API への直接通信は発生せず、AWS 資格は Ex 内で管理する。

Drive を使う場合は項目に `drive: {folderId, clientIdEnv, clientSecretEnv, refreshTokenEnv, sourceRevision, expectedNames, maxArtifactBytes}` を追加する。Ex の runner に非秘密入力 `CC_CLOUD_ATTEMPT_ID` を登録する。runner 専用の Drive 書き込み資格を実行環境に設定し、Cc の回収資格から同じ OAuth アプリの `appProperties` が見えるフォルダを使う。これらの資格やアップロード URL は Ex のジョブ入力に入れない。runner は各ファイルに `ccTarget` (Ex の対象 ID)、`ccAttempt` (`CC_CLOUD_ATTEMPT_ID`)、`ccName` (登録済み成果名) を付け、最後に同じ属性で `result.json` を置く。

```text
{version: 1, attemptId: CC_CLOUD_ATTEMPT_ID, sourceRevision, status: "completed", artifacts: [{name, bytes, sha256}]}
```

Cc が Drive へ送るのは回収時の OAuth 更新リクエスト、固定フォルダと依頼 ID に対する一覧・manifest 取得のみ。チェックサムの無い Google ドキュメント形式は対象外。実機で runner 側のファイル登録と Cc 側の回収を確認する。

応答喪失時は WebUI の「AWS の状況を確認」か MCP の `status` を同じ依頼番号で実行する。一覧の照合は一回につき最大 2,000 件。見つからなければ Ex の台帳を `job_id` で確認し、送信の有無を確認できるまで新しい依頼を発行しない。Cc の設定を外すと新規受付を止められる。既存の `cloud-work/aws/runs.sqlite` と Ex の台帳を保ち、同じ操作 ID で停止・解放を確認する。未確認枠を解除するための台帳削除は行わない。
