---
id: CC-AUTO-TITLE-TASK-STOP
status: draft
---

# 自動タイトル変更タスクの停止

neco の2026-10-04開始指示に対応する。セッションの初回観測、repo変更、prompt受信を理由に、CcからLictorへタイトル変更だけの仕事を注入しない。

価値は UX-CC-SC-W3。既存 observability の stat watcher が観測を契機に不要な仕事を作らない。SessionsRepo が作業名を所有し、pending task は TasksRepo が所有する。新しいドメインは作らない。

- AT-01: watcher は初回・repo変更・prompt・再監視で title-suggest をenqueueしない。TasksRepoへの書き込み依存を除去する。
- AT-02: current_task に基づく既存 title_renamed イベントと同じ値の重複抑止を保持する。
- AT-03: 他種のpending taskと、人間の明示的request-title/title-suggestion APIは維持する。既存タスクの一括削除はしない。

相談チャンネル名をHaiku要約で更新する追加指示は別タスクで扱う。この変更は要約APIを新設しない。

復旧は本変更commitのrevert。ローカルテスト・サービス操作は未実施。Revisor登録テストで検証する。実機評価は未確認。
