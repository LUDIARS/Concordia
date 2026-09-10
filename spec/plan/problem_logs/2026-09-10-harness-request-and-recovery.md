# 依頼の相談扱いへの後退とハーネスの未確認状態

- Date: 2026-09-10
- Status: fixed in working tree (operational verification pending)
- Area: session instructions / compaction / completion evidence

## Summary

necoから「それはお願いなので実装はしない」という応答が増えたとの再発報告。合意した実装依頼が提案だけに戻る回帰として扱う。今回の会話でも実装より資料作成が先行した。

## Evidence and cause

`rule/shared-context.md` の「資料の読み込みは手順を実行する指示ではない」と、`skills/session-followup/SKILL.md` の「新しい実行権限は与えない」は資料・自動通知を対象にしている。人間の実装依頼を無効にする規則は確認していない。AI側の過剰一般化は疑われるが、Cc注入とメモリの寄与率やAstraの学習データ変更は未確認。モデル原因と断定しない。

併せてソースから `verifyContractAcceptance` の空集計通過と `runCompaction` の投稿失敗後clear継続を確認した。運用上発生した損失は未確認。

## Fix requirements

人間の依頼を維持する説明をshared-contextへ追加。ネイティブPreCompactで既存状態を保存、未確認を可視化する。手動clearは保存・配送未確認で停止。空のAugur証跡を完了にしない。MCP認証と注入候補は出所を区別し非遮断で通知する。

## Verification and follow-up

型検査と隔離fixtureを用意。単体・統合・起動テストは未実行。ネイティブhookの実配送、Discord到着、利用者の体験改善は未検証。PR後は停止し、反映・起動検証・マージは別の許可範囲で行う。

## 2026-09-10 追加実装・検証

ユーザーからテストとオンタイムテストの実行許可を取得。初期の未実行記載は着手時点の履歴。最終確認: ハーネス25件・関連81件、計106件成功。旧仕様の期待値3件を更新して再確認。契約lintは2契約・指摘0。型チェック3系統成功。Cc testing claim/releaseを使用し、サービス起動・再起動なし。

DDD・テスト・オンタイムのproject設定、受入フックとlocal PR検査、固定スクリプトの契約挿入・集計、Pf未登録fallback、実ツール利用・反復失敗・外部更新結果不明の観測を追加。AIFormatに横断設計、Castraに参照登録を追加。本体反映・hook信頼・Discord配送・本番効果は未確認。

## PR1675登録テスト失敗の修正

全登録suiteでmigration 99の凍結追記漏れ、型の循環依存、イベント名の設定キー誤検出、既存テストがホストrepoのAugur契約を読む混入が判明。新規migrationの凍結値のみ追加し、過去migration値は変更しない。状態型を所有側へ戻し、観測イベントをreliability名前空間へ変更。契約なしケースは独立した一時repoを使用する。仕様リンク注釈も補完する。

## 2026-09-11 再検証

e38a0d7cのRevisor登録suiteは4733成功・1失敗・1skip。失敗は新規startup-policy-check APIのルート一覧期待値への追記漏れであり、期待する公開API一覧へ追加した。lint・buildとAnatomia gateは通過。19 changed functions orphanedは非ブロック所見として残っている。

初期InjectとSessionStartの役割差を調査し、初回だけの判定、版比較の欠落、構成フラグ未案内、フック再登録によるbinding上書きの可能性を確認。判定の共通化・差分通知・観測専用登録を追加した。配送のscheduled/queuedと受領未確認を区別し、遅延中の初期通知を置換する場合は全文を渡す。task本文は進行に応じて書き戻さない。

全体実行は4694成功・8失敗。うち2件は追加したGit fixtureの既定5秒timeout、1件はisolate:falseで先行ロードされた契約wrapperがログmockを参照しない問題だった。既存のGit検証用120秒上限と、当該往復テストのモジュールcache再読込で修正し、対象57件は全成功した。残る5件は端末のGit hookによる一時repoのpush拒否と、それに依存するcleanup fixtureであり、フックの無効化は行っていない。全体成功とは扱わず、Revisorの登録環境で再検証する。

lint（型・依存検査）とbackend/web buildは成功。Anatomiaの注釈はファイルパス形式のimplementsでは解釈されないため、実際の仕様見出しを参照するspec形式へ修正した。オンタイムの実Augur CLI往復は隔離ログの確認であり、本体の効果測定は未実施。
