---
id: CC-CLOUD-COLAB
title: 本人同席の一般版 Colab 実行
status: draft
domain: cloud-execution
---

Actio `actio:cf6b45c9-6e28-47c1-b030-7cad7d551ffa`。UX-CC-W2/W3/W4/W5、シナリオ S2/S3/S4/S5/S6。CC-INV-02/03/04/07/08。

## 所有する状態と操作

Cc の cloud-execution が開始承認、依頼指紋、割当の受付、観測、回収、解放を記録する。
Actio はタスク、依頼者は品質検収、Google はランタイムの実状態を所有する。
固定テスト・学習を対象とし、登録済み GPU、固定 revision と SHA-256 の notebook または Python スクリプトを選ぶ。
依頼データからコード、環境、秘密、出力先を変更できない。

- CC-CLOUD-COLAB-01: WebUI の認証済み本人の明示開始、公開コード、非機密データ、本人の許可先、既存予算ゲートと登録時間・使用量上限が揃った場合にだけ一次受付を保存する。Colab は自動選択・batch の対象外。登録主体を横断して同時実行 1、同一依頼は試行 1。
- CC-CLOUD-COLAB-02: provider 副作用の前に UUID4 requestId、専用 runtime 名、受付時刻、期限、実行指紋を保存する。割当 operation ID は入手時に保存する。応答喪失は名前または operation で照合する。割当や kernel 実行を再送しない。
- CC-CLOUD-COLAB-03: Jupyter は短命 proxy token を必要時に読み直す。実行終了、worker 申告、報告の整合性、品質検収、解放を別々に記録する。小さい判定報告は読み戻す。大きいチェックポイントは既存 Drive のファイル別の返送先に保持し、限定フォルダ内の URI、サイズ、検証済み SHA-256 を記録する。
- CC-CLOUD-COLAB-04: 受付からの期限を Cc が保持し、正常・異常・期限超過・停止時に同一ランタイムを解放する。削除要求の成功だけでは解放とせず取得で不在を確かめる。割当が未確定のまま不在の場合は解放不明とし、排他枠を保持する。再起動後は実行を再開せず資源の照合と解放を続ける。

## 認証と運用

本人が Colab API を有効にした OAuth クライアントと `https://www.googleapis.com/auth/colaboratory` の同意、
利用プラン、compute units、GPU spec、必要時の本人 Drive フォルダを確認する。
Colab と Drive は用途別の資格を利用する。CLI 資格キャッシュは使用しない。
Excubitor 側には本人・サービス・用途ごとの Vault 参照を解決し、Colab と任意の本人 Drive について短命資格を返す
OS 保護 IPC または transport の登録が必要。利用する資格経路に本人の構成が揃っていなければ開始を拒否する。

委託画面で作業セッション・Actio タスク・登録済み Colab target を選び、送信先、公開区分、同席を確認して開始する。
`/v1/delegation/cloud/colab` の `/targets`、`/runs`、`/runs/:id/stop`、`/runs/:id/collect`、`/runs/:id/quality` は、
Cernere を通った WebUI の本人 ID と組織 ID を使う。書き込みは同一オリジンのブラウザー操作に限る。
既存の `CONCORDIA_CLOUD_CONFIG_FILE` に `provider: colab`、`transferMode: jupyter` と固定 `sourceRevision` を設定する。
`colab` 登録には `ownerId`、`organizationId`、`credentialRef`、`destination`、`code: public`、`data: non_confidential`、
`program`、`programSha256`、`runtimeSpec`、`maxSeconds`、`usageUnitsPerMinute`、`maxUsageUnits` を記載する。
任意の本人 Drive は `drive: { credentialRef, folderId, checkpointNames }` を同じ Colab 登録に追加する。
使用量の上限は見積もりに対して適用し、Google 側の残高・課金額は本人が確認する。
同じタスク・対象・固定版・期限・公開区分の指紋は再度投入しない。

既存の暗号化された Cc 設定ストアと Drive の Google OAuth 交換を利用する。
設定キーは `cloud_work.oauth.<SHA-256>`、ハッシュ対象は UTF-8 の JSON 配列
`[organizationId, ownerId, purpose, credentialRef]`（purpose は `colab` または `drive`）。
保護された経路で `clientId`、`clientSecret`、`refreshToken` の JSON を登録する運用が前提。
Excubitor で資格を一元化するときは同じ主体/用途境界を持つ `ColabCredentials` を接続する。

登録済みプログラムは `CC_CLOUD_INPUT` の `attemptId`、`sourceRevision`、`uploads` を受け取る。
`uploads` の各 URL は既存 Drive 返送の単一ファイル用 capability。プログラムは該当ファイルのバイトを送信し、
Jupyter の作業ディレクトリに UTF-8 の `cc-result.json` を書く。必須項目は `version: 1`、元の依頼 ID と revision、
`exitCode`、`tests: { total, failed, skipped }` または数値の `metrics`。
チェックポイントを送った場合は `checkpoints: [{ name, bytes, sha256 }]` を付ける。
Cc は Drive の限定フォルダ内でファイルサイズ・SHA-256 を照合して URI を記録する。worker 申告を保存済みなら、解放後も Drive の照合だけを再試行できる。
所有者は実行中に WebUI を開き、手動で停止できる。Cc の期限は Cc 稼働中に効く。
Cc 停止中に残ったランタイムは本人が Colab で確認できる。journal を保ったまま登録と資格を復旧し、元の ID を照合する。
資格未設定、実機・プラン・GPU の有効性はデプロイ時に確認する。
AWS 計算と Colab Enterprise は別の設計対象。

- [一般版 Colab REST](https://developers.google.com/colab/api/reference/rest)
- [Jupyter 接続情報](https://developers.google.com/colab/api/reference/rest/v1beta/runtimes#ConnectionInfo)
