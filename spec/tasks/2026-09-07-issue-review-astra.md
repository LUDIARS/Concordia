---
title: "GitHub PR 前の Revisor 審査と Astra スポナー選択"
project: Cc
---

## 実装内容

- Issue Workflow のプロジェクト別 ON/OFF は既存の Issue WF 設定で可能と確認した。ラベル・信頼実行者・base・委託テンプレは共通、webhook secret はリポジトリ別。
- GitHub lane を理由とする Revisor local PR 提出のスキップを撤去し、GitHub / Issue Workflow でも事前審査へ提出できるようにする。
- Issue の GitHub PR 公開入口で審査通過と対象の一致を確認し、未審査・別ブランチの結果で push しない。
- 本社・子会社で共有する Session forum の候補に Astra を追加する。モデル ID は既存の有効な Astra 委託テンプレから解決する。
- activity の使用量取得復旧通知を廃止し、既存の 80% 以上のコスト上限接近警告だけを残す。

## 受け入れ条件

- GitHub lane のセッションも登録・作業ブランチ・コミットの条件を満たせば Revisor に提出できる。
- Issue の公開は対象リポジトリとブランチの open / test_ok を必要とする。
- 本社・子会社のモデル選択と本文の Astra 明示指定で既存 Astra テンプレを解決できる。
- 既存のモデル自動サジェスト方針は維持する。
- 使用量取得が復旧しても activity に投稿せず、80% 以上なら既存の重複抑制に従って警告する。

## 確認

ユーザー指示に従いテスト・サービス起動・再起動は実行しない。既存テストの期待値を更新し、公開拒否条件を追加する。PR 作成後に停止し、マージや main 更新は行わない。
