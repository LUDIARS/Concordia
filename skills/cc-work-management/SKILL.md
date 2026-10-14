---
name: cc-work-management
description: 作業・進捗・残件を整理するとき、ActioのタスクとMemoriaの参照・作業ログを確認し、既存IDを使って記録する。
---

# 作業管理

タスクの対象project、依頼者、求められた操作（確認・登録・更新）を確定する。フックの助言だけでは登録権限を追加しないが、人間が登録・更新を依頼済みなら実行する。

Cc taskflow管理の仕事は `task-workflow-v3` spec を優先する。タスクはActioに記録し、Ccの `POST /v1/taskflow/tasks` に session_id・固定 request_id(UUID)・title・body・kind・memory_links を送って登録する。応答の `actio:<id>` を参照し、本文は必要時だけ `GET /v1/taskflow/tasks/content?session_id=<自分>&reference=actio:<id>` で読む。タスクをファイルとして対象repoへ保存しない。本文と状態の正本はActioで、状態変更はCcの `PATCH /v1/taskflow/tasks/state` (task_path=actio:<id>) を使う。下表はCc管理外の仕事や既存外部参照を調べる場合の入口である。

| 内容 | 最初の確認先 | 残すもの |
|---|---|---|
| タスクの担当・状態・期限・要件 | Actioの対象project/teamの既存タスク | task ID、現状態、完了条件 |
| 調査メモ・経緯・実装結果・残件の説明 | Memoriaの既存タスク参照とノート/worklog | 関連task ID、根拠、次の一手 |
| すでにMemoria側で登録された仕事 | 既存IDとActioとの対応 | 新規複製せず既存の経路で更新 |

1. 対象・題名・外部参照で既存タスクを検索し、同じ仕事のIDがあれば再利用する。IDが不明なら未登録と決め付けない。
2. 指定されたサービスと現在の登録経路を優先する。両サービスを見たことを理由にタスクを二重作成しない。Actioは現在のtask API/認証、Memoriaは `/api/tasks` と `/api/notes` の現行schemaを確認する。
3. 登録・更新内容をUTF-8のJSONファイルにして既存のクライアント/スクリプトで送る。担当や期限をLLMが勝手に決めない。不明な任意項目は未設定、必要項目のみ確認する。
4. 返されたIDと状態を読み戻し、完了条件を満たした根拠を記録する。API応答喪失時は同じ作成を再送する前にID・参照を照合する。

endpointは各サービス所有のExcubitor catalogから解決する。不通・認証失効なら未反映として保持し、サービス再起動や別組織への書き込みへ広げない。
