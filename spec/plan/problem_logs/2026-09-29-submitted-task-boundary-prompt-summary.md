# 提出後の同一 PR 修正が submitted-task-boundary で止まる

- Date: 2026-09-29
- Status: fixed in working tree
- Area: Concordia harness (task-branch gate)、session lifecycle、local PR 提出
- Severity: Revisor が指摘した PR の修正を、人間が「PR 2150 の修正を続けて」と指示しても commit できない。Bash / Edit / Write がすべて拒否される

## Summary

Astra With Sidecar (local PR #2150) が情報流出候補でブロックされ、同じ branch へ修正を足そうとしたところ `[submitted-task-boundary] … に別作業を混ぜることはできません` で全ツールが止まった。人間の指示を受けても解除されなかった。

## Evidence

- セッション metadata の `task_branch_submission.task` は、提出時に届いていた人間の指示文 (Opus/Fable の movable 化の依頼) だった。
- 同時点の `current_task` は直近の指示の要約 (「PR 2150 の修正を続けて」) だった。
- `checkSubmittedTask` は `previous.task === input.task` を要求するため、指示のたびに必ず不一致になり「別作業」と判定した。
- 分類器へ渡す `submittedTask` も提出時の指示文で、PR の識別子を含まなかった。

## Cause

`current_task` 列は `/v1/sessions/:id/events` の prompt event で人間の指示の要約に上書きされる (`src/api/sessions/events.ts`)。ゲートはこの列を「宣言した作業」とみなして境界の同一性に使っていた。提出時の記録も同じ列から取っていたため、提出後に届いた指示は常に別作業になった。

## Fix Requirements

- `PATCH /v1/sessions/:id` の `current_task` (`lictor cli task set` の宣言) を `declared_task` として別に保存し、境界の同一性はこれで比べる。
- 提出時の記録に PR の表示名 (`<repo>#<number> <title>`) を持たせ、分類器へ渡す。
- 指示が提出済み PR をその番号か branch 名で直接指していれば、LLM 分類を待たずに same-task とする (別作業を示す語があれば判定しない)。
- 旧形式の記録 (宣言タスクなし) は、タスク文を比べずに分類結果だけで判定する。
- 宣言タスクを別の作業へ変えた場合は、分類結果に関係なく拒否を続ける。
