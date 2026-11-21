---
id: CC-CF-INTEGRATION
status: draft
---

# Conflux 連携

Actio `0bb2b428-c3b8-49e0-b8a1-d0a76f5e387a`。UX-CC-W1/W2/W3/W5、UX-CC-S1/S2/S3/S4/S6。
Cf Flow の実装依頼を出した利用者は同じキーで実セッションを照会できる。
ビルドと採用判断の画面は、Cc が観測したビルド状態と Revisor の合流結果を受け取る。

- CC-CF-INV-01 同じ依頼キーは同じ受付に対応する。異なる内容との衝突は 409。結果が不明な起動を再発行しない。
- CC-CF-INV-02 Flow を有効にした登録プロジェクトだけを扱う。作業ブランチは選択した亜流の本流に由来する。従来の審査ゲートを維持する。
- CC-CF-INV-03 Cf のビルド ID と採用判断 ID は Cf の識別子を使う。ビルドイベントの sequence は単調増加する。
- CC-CF-INV-04 役職は認証した本人の所属の名簿から取得する。配送障害はビルドやマージ処理へ伝播させない。

## HTTP 契約

Cc の入口は直接の loopback 用。エラー本文は `{error: string}`。
Cf → Cc の各要求は既存 adapter と同じ JSON を使う。

| 用途 | メソッドとパス | 要求と応答 |
|---|---|---|
| 起動 | `POST /v1/conflux/spawn` | `{idempotency_key, project_code, destination:{kind,address}, selection, title, brief, requested_by, source_comments}`。実セッション登録後は 200 と `{accepted:true, session_id, run_id, status}`。同一内容は受付を再利用し、衝突は 409。起動結果が確定していなければ 503。 |
| 起動照会 | `GET /v1/conflux/spawn?idempotency_key=…` | 応答は起動と同じ。台帳にキーが無い場合は 404、起動を拒否した受付は 409。 |
| ビルド | `POST /v1/conflux/build` | `{dedupe_key, project_code, tide, variant, commit, branch?, platforms}`。登録済みの実行先へ 202 と `{accepted:true}`。同一キーによる二重起動を防止し、内容の衝突は 409。 |
| 役職 | `GET /v1/conflux/identity` | `Authorization: Bearer <actor token>`。200 と `{actor_id, organization_id, role, roles, is_manager}`。資格情報の不一致や名簿の対象外は 401。執行役員の `roles` は管理職を包含する。 |
| ビルド・統合の通知 | Cc から `POST /api/hooks/build-events` と `POST /api/hooks/integration` | Cf に `Authorization: Bearer <CONFLUX_HOOK_TOKEN>` を付けて送信する。ペイロードは下記。 |

起動の `run_id` は Cc が発行する Conflux 受付 ID。セッション登録に使う資格情報は返さない。
`selection` は既存の `/v1/harness/conflux/select` と同じ構造を使う。起動時にも同じ選択を
セッション登録へ引き継ぎ、Cf からの再登録を受け付ける。通常フローの main 起点と Revisor の採否は継続する。

- ビルドは `{dedupeKey, projectCode, variantId, commit, seq, state, failureSummary?}`。Cf の
  `projectCode` と `variantId` は `cf-build:<projectCode>:<variantId>:<commit>[:retry-<n>]` から取得する。
  Cc のレジストリを引くときは別フィールドの `project_code` を使う。
- 統合は `{projectCode, decisionId, source:"revisor", commit, outcome:"integrated", ref}`。
  Cf の採用判断 ID と対象コミットは運用担当者が Revisor PR ID に対応付ける。Revisor が merged を返し、
  リポジトリと head SHA が一致したときだけ、その PR ID を `ref` として配送する。

## 配線

| 設定 | 値または形式 |
|---|---|
| Cf `CONFLUX_CC_SPAWN_PATH` / `CONFLUX_CC_SPAWN_LOOKUP_PATH` | いずれも `/v1/conflux/spawn` |
| Cf `CONFLUX_CC_BUILD_PATH` | `/v1/conflux/build` |
| Cf `CONFLUX_CC_IDENTITY_PATH` | `/v1/conflux/identity` |
| Cc `CONFLUX_URL` | Cf のベース URL。loopback HTTP または HTTPS |
| Cc・Cf `CONFLUX_HOOK_TOKEN` | 同じ共有鍵。Cc の URL または鍵が未設定の場合、配送処理は停止する |
| Cc `CONCORDIA_CONFLUX_DESTINATIONS` | `[{project,kind,address,subsidiaryId?}]`。project は Cc のコード。address は子会社なら `{subsidiary_id}`、Discord は `{guild_id,channel_id}`、Slack は `{channel_id}`。Discord の子会社は `subsidiaryId` を指定する |
| Cc `CONCORDIA_CONFLUX_ACTORS` | `[{sha256,platform,userId,organizationId}]`。本人に発行した十分にランダムなトークンの SHA-256、名簿の本人 ID と所属を登録する。本社は `hq`。役職は照会時に名簿から読む |
| Cc `CONCORDIA_CONFLUX_BUILD_RUNNERS` | Cc コード → 運用管理下の Node.js ビルドスクリプトの絶対パスの JSON オブジェクト。スクリプトは専用の detached worktree で `{commit,platforms}` を JSON 引数として受け、終了コードで結果を返す |
| Cc `CONCORDIA_CONFLUX_INTEGRATIONS` | `[{prId,projectCode,repository,decisionId,commit}]`。projectCode は Cf の値、repository は Revisor の owner/repo、commit は Cf 採用判断の SHA |

Slack 宛先には作業セッション専用チャンネルの参照を届ける。送信先は登録したチャンネルに限る。
ビルドスクリプトは環境変数を最小限だけ受け取る。実行対象のコードとスクリプトは運用担当者が管理する。
成果物 URI やファイル配送はこのスクリプト契約の外にある。

## 回復

Migration 152 は受付、キュー、通知台帳を追加する。受付後に起動結果を失った場合、同じキーで実セッションを
照会する。照合できない受付の再発行には運用担当の確認が必要。実行途中のビルドは再起動時に中断の失敗として記録し、
Cf の明示的な再試行を待つ。通知は成功まで間隔を広げて再送する。配送結果が不明な場合も同じ sequence と payload を送る。
停止時はワーカーと配送を停止し、受付と通知を保持する。

合流検知は [再試遊帰還](merge-playtest-return.md) でも使う。採用判断との照合には PR の head SHA、
帰還ビルドの対象には Revisor の merge SHA を使う。帰還で積むビルドは Cc 内部の依頼で、
Conflux 通知台帳へ送る採用判断・ビルドイベントは従来の外部 ID を持つ依頼から生成する。
