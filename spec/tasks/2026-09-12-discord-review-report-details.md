---
task: Discord フォーラムで Revisor の詳細審査レポートを読む
project: concordia
kind: feature
created: 2026-09-12
memory_links: []
---

neco の「実装やってくれる？」「Rvの詳細レポートから着手」に基づく実装。
警告対応は取り消し済み。リリース通知整理とユーザー報告起点の復旧は別作業。

Revisor の attempt 単位の詳細履歴を読み、PR 本文、審査開始、各チェックの開始・結果・
スキップ理由、レビュー内容、最終判断を Discord に掲載する。長い文書は全文添付にし、
通常コメントからはセッションを起動しない。既存の明示的な操作は維持する。

受入条件:
- 旧形式は取得範囲を明記し、不正な新形式を成功扱いしない。
- レポートの送信失敗・応答喪失では Bot の配送済み指紋を照合して再試行する。
- 同期の間に終了した未掲載 PR を軽量一覧から拾い、個別詳細で補完する。
- 終局詳細が取得できない場合は閉鎖を保留し、最終レポートを送信してから閉じる。
- テストの実行、再起動、デプロイ、マージは行わない。静的型検査で確認し PR 提出で停止。

仕様: spec/feature/revisor-test-forum-sync.md
生産側依存: Revisor reviewReport v1 と軽量一覧の reviewReportVersion。

検証記録: TypeScript の production / test 設定の静的型検査 PASS。
Anatomia verify は --project 指定時に共有 checkout を解析したため新規コードの
spec_linkage が FAIL。仕様の明示 ID を付け、--repo のみで当 worktree を解析すると
rule_conformance / duplication / spec_linkage / coupling_delta / convention_drift 全て PASS。
テストコードは追加・更新のみで未実行。Discord の実配送とサービス再起動も未実施。
