/** Immutable literals used by already shipped migration 59. */
export const TASK_MD_CONTENT_RULE =
  "タスクは対象リポの spec/tasks/<YYYY-MM-DD>-<slug>.md に 1 タスク 1 ファイルで新規保存する。" +
  "frontmatter は task / project / kind / created / memory_links だけを書く。";
export const TASK_STATE_DB_RULE =
  "status・assignee・owner・delegation_run_id・pr_number・memoria_task_id などの進行状態は " +
  "Concordia の DB (taskflow_task_state) が正本である。md には書かず、 後から書き戻しもしない " +
  "(task md が更新差分を作らないようにするため)。";
