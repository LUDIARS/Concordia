# Revisor PR #140 が古い base SHA で審査失敗

## 概要

- 発生日: 2026-08-04
- 対象: Concordia / Revisor local PR #140
- 症状: Revisor が登録済み base SHA と現在の `main` の SHA 不一致を検出し、審査を開始できなかった。
- 影響: Test Forum の操作面・テスト開始・マージ操作の変更が未審査のまま停止した。

## 原因

PR #140 は `4f30f9c` を base としていたが、現在の `main` は `a1b4591` まで進んでいた。後から main に入った Test Forum の投稿更新・QA セッション連携が同じファイル群と migration 48 を変更しており、単純な再試行では解消できない状態だった。

## 対応

- `fix/test-workflow-controls` を現在のローカル `main` へ rebase した。
- main 側の投稿詳細表示、内容指紋による更新、QA delegation のライフサイクルを保持した。
- PR #140 側の操作状態・実行設定を migration 49、spawn target を migration 50 に移し、`SCHEMA_VERSION` を 50 に更新した。
- 統合後の型に合わせてテスト fixture と仕様書を更新した。

## 検証

- conflict marker が残っていないことと `git diff --check` を静的に確認した。
- セッション方針に従い、ローカルの単体・統合・起動テストは実行していない。Revisor の登録済み審査で確認する。

## 再発防止

失敗理由が base SHA の不一致で、同じ領域の変更が main に入っている場合は、既存PRをそのまま再試行せず、現行 main へ rebase して migration 番号と複合機能のライフサイクルを明示的に統合してから再審査する。
