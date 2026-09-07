---
type: plan
title: "Issue 受付・ワーカー寿命・上限通知の運用レビュー5件"
service: concordia
status: implemented
updated: 2026-09-07
---

# Issue 受付・ワーカー寿命・上限通知の運用レビュー5件

- Date: 2026-09-07
- Status: fixed in working tree; execution tests not run
- Area: GitHub Issue workflow / delegation queue / worker leases / cost notifications
- Severity: 受付と実行結果の見失い、ワーカーの所有権喪失後の処理継続、警告欠落・投稿重複

## Summary

neco のコード品質・運用レビュー依頼に対し、ソースから5件の失敗経路を特定した。
本記録は実行再現や本番事故の発生を主張するものではない。修正は Sol が担当し、親セッションが
コードレビュー、静的な型確認、スキーマ台帳の算出と UX・DDD 文書との対応を確認した。

## Evidence

修正前のコードは本作業の基点 `aba3b27c02ae` で参照できる。

| 指摘 | ソース上の証拠 | 利用者への影響 |
|---|---|---|
| 1 | `dispatchIssueTrigger` が本文保存・invoke より前に run を作成。poll は既存行を除外し、tracker は `queued` を対象にしない | 中断した受付が再開せず、非終端なので retry もできない |
| 2 | workflow-worker の shutdown は `queue.stop()` 後に DB を閉じ、stop は timer を消すだけ | 実行中 launch の結果保存前に終了し、子プロセスと台帳が食い違う |
| 3 | `startWorkerLease` の所有権喪失を consumer が購読せず、heartbeat 失敗時のローカル失効期限もない | 所有権を失った旧ワーカーが処理を継続する |
| 4 | `notifyHigh5hUsage` が send より先に通知済みを保存 | 一時的な Discord 障害で上限警告が失われる |
| 5 | `upsertCostChannelMessage` が fetch/edit と activity を同じ catch に含める | activity の障害で、更新済みの cost 投稿を重複作成する |

## Regression Context

送信失敗後の再試行・キュー所有権・プロセス終了は既存の運用契約であり、その境界に抜けがあった。
今回の5経路について、過去に一度修正済みだったものの再発とは確認していない。

## Cause

受付・起動・結果確定が同じ状態に重なり、中断点を永続状態から区別できなかった。
また、timer の停止と実行中処理の完了、lease の記録と consumer の寿命、通知試行と配達確定が
それぞれ接続されていなかった。

## Fix Requirements

- `queued / ready / dispatching / dispatch_unknown` を区別し、受理本文の hash と run ID を含む
  委託相関を保存する。本文未検証では起動せず、結果不明を再試行可能な失敗に偽装しない。
- 旧 hash のない `queued` は起動済みかもしれないため照合・結果不明に限定する。過去の試行との
  誤結合を、作成時刻と不変の委託引数の照合で防ぐ。
- queue 停止で全 drain の新規取得を止め、実行中の結果処理を待つ。最初の drain より前に
  終了シグナルを購読し、standalone worker の生存用 timer を所有する。
- lease 喪失通知とローカル有効期限を consumer の停止に接続し、非同期初期化の前後でも確認する。
- 上限通知は送信成功後に記録し、同じ警告の同時送信をまとめる。cost 投稿の再作成は
  Discord の `Unknown Message` に限定する。

## Verification

`tsc --noEmit` による backend、web、test-source の静的型確認は通過した。
単体・統合・動作・起動テスト、サービスの起動・再起動はユーザー指示により未実行。

回帰ケースは `dispatch.test.ts`（本文復旧・改変拒否・結果不明・本文欠落）、
`tracker.test.ts`（照合・期限切れ・旧状態）、`queue.test.ts`（終了時の drain 待機）、
`worker-lease.test.ts`（CAS 喪失・DB 障害中の失効）、`cost-channel.test.ts`
（送信失敗・並行警告・投稿重複防止）に記述した。これは実行成功の報告ではない。

Migration 96 の schema fingerprint は SQL 文字列を静的に再構成して算出し、変更前の再構成値が
既存 version 95 の凍結値と一致した。migration 関数・SQL を実行して検証したものではない。

## Follow-up

実行確認は明示許可された工程で行う。結果不明の run は外部起動の証拠を照合し、証拠なしに
手動で失敗へ変更して再起動しない。今回の作業セッションは commit と local PR 提出までで停止する。

UX の対応先は `UX-CC-W2/W4/W5`、業務不変条件は `CC-INV-03/04/06/07`。
定義は [product UX](../../ux/product.md) と [DDD 方針](../../architecture/ddd.md) に記載する。
