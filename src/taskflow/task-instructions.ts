/**
 * タスク分解を促す inject / ハーネスルール / inject マニュアルで共有する規範文言。
 *
 * task md に status や PR 番号を書き戻す運用は、 タスクが進むたびに md の更新差分を
 * 作り、 実装 PR に無関係な diff を載せてしまう (2026-08-09 neco 指示)。 進行状態は
 * `taskflow_task_state` (Cc DB) が正本で、 md は分解時に一度書くだけの本文とする。
 *
 * 文言を 1 箇所に集約するのは、 inject 経路 (decompose / residual)・ハーネス builtin
 * ルール・kind 別 inject マニュアルで規範がずれるのを防ぐため。
 *
 * @implements spec/feature/task-workflow.md §2.1 / §2.3
 */

/** md に書いてよいもの (本文 + 最小 frontmatter) と、 書き方 (新規保存のみ)。 */
export const TASK_MD_CONTENT_RULE =
  "タスクは対象リポの spec/tasks/<YYYY-MM-DD>-<slug>.md に 1 タスク 1 ファイルで新規保存する。" +
  "frontmatter は task / project / kind / created / memory_links だけを書く。";

/** md に書いてはいけないもの (進行状態) と、 その正本。 */
export const TASK_STATE_DB_RULE =
  "status・assignee・owner・delegation_run_id・pr_number・memoria_task_id などの進行状態は " +
  "Concordia の DB (taskflow_task_state) が正本である。md には書かず、 後から書き戻しもしない " +
  "(task md が更新差分を作らないようにするため)。";
