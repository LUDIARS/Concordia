---
task: task-link-legacy-reference
project: Concordia
kind: implementation
created: 2026-10-02
memory_links: []
---

# 旧来 Actio タスク (cc-taskmd) を指示参照として紐付け可能にする

neco 2026-10-02 の指示。Director case dir_bef3ad802d904139933b29c02db8123e の plan v1 で承認済み。
仕様: ../feature/task-linked-followup.md「旧来タスク (cc-taskmd) の参照」(CC-TASK-LINKED-FOLLOWUP)。
domain: session-coordination (関連付け) / taskflow (Actio 読み込み)。

## 受け入れ条件

- source `cc-taskmd`、project と owner が binding と一致し、team が binding の範囲内か team 無しのタスクを関連付けできる (201)。
- 関連付けた旧来タスクの状態 (done 等) が `GET /v1/sessions/:id/task-links` で現状態として表示される。
- source が cc-taskmd でも v3 でもないタスク、project か owner が違うタスクは、従来どおり actio_task_out_of_scope。
- 旧来タスクは taskflow の作業候補・状態更新・担当割り当てに使われず、taskflow state にも登録されない (既存の `read` は変更しない)。
- 純関数とストア・関連付けの単体テストを付け、cc.acceptance.json に対応付ける。

## タスク分解

1. 純関数 `isLegacyReferenceInScope(binding, task)` を src/taskflow/actio-reference-scope.ts に置く (source・project・owner・team の判定)。
2. `ActioWorkflowClient.getReference(binding, id)`: v3 は既存の scoped 判定、旧来は純関数で判定する読み取り専用の取得。
3. `TaskStore.readReference?(repoPath, reference, subsidiaryId)` を追加し、ActioTaskStore は taskflow state に登録しない文書を返す。
4. session-task-links の関連付け・表示で `readReference ?? read` を使う。
5. テストと cc.acceptance.json の対応付け。Revisor local PR で提出し、マージ後に cc-deploy で反映、実タスクで紐付けを確認する。
