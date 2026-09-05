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

/**
 * kind 別 inject マニュアル向けの短縮版。 マニュアルは 1 行の手順文の中に収める必要があり
 * `TASK_STATE_DB_RULE` の列挙をそのまま置くと長すぎるため、 同じ規範を要約した別文を持つ。
 *
 * **この値は migration 59 (taskflow-inject-state-in-db) が書き込むリテラルと一致していること。**
 * seed (`inject-manual-seed.ts`) は既存行を上書きしないので、 稼働中 DB の既定行は migration が
 * 書いた文字列のまま残る。 ここを変えるだけでは既存 DB に反映されない — 文言を変えるときは
 * 既定行を差し替える migration を別途足すこと (適用済み migration は書き換えない)。
 */
export const TASK_STATE_DB_RULE_SHORT =
  "進行状態 (status / 担当 / PR 番号 / 外部タスク ID) は Concordia の DB が正本なので、既存 task md へ書き戻さない。";

/**
 * 委託先セッションが人へ質問するときの唯一の作法。
 *
 * 2026-09-05 の問題ログ (spec/plan/problem_logs/2026-09-05-delegated-claude-session-used-askuserquestion.md):
 * 委託された Claude セッションが AskUserQuestion (対話 picker) で質問し、 Lictor リレー越しに
 * 回答できず run が止まった。 子への指示に「質問の出し方」が無かったのが原因なので、
 * 規範をここに 1 本置き、 persona-context (子への指示) と implementation-inject (受け入れ条件)
 * の両方がこれを参照する。 経路ごとに文言を書くと片方だけ古くなる。
 */
export const ASK_MARKER_RULE =
  "ユーザへの質問・選択提示は ```ask を情報文字列にしたフェンス付きコードブロックへ JSON を 1 個だけ入れて出し、" +
  "そのままターンを終了して回答を待つ " +
  '(`{"question":"…","multiSelect":false,"options":[{"label":"…","description":"…"}]}`)。' +
  "AskUserQuestion などの対話 picker はリレー (Discord 等) 越しに回答できないので使えない。" +
  "選択肢の無い純粋な自由質問はブロック無しの地の文で聞く。";

/**
 * 受け入れ条件の契約書式 (Augur 設計 2026-09-05-live-contract-testing.md §8 / C4)。
 *
 * 「動いたつもり」の自己申告を機械で突合できるようにするため、 受け入れ条件は 1 行 1 契約の
 * 書式で渡し、 契約 id を完了報告の `acceptance_report[].criterion` の先頭トークンにする。
 */
export const ACCEPTANCE_CONTRACT_FORMAT_RULE =
  "受け入れ条件は契約書式 `C-n <symbol>(…): <条件>` で 1 行 1 契約として書く " +
  "(例: `C-1 verifyCompletionEvidence(run): 契約ファイルがある run は Augur の集計と突合する`)。" +
  "契約 id `C-n` は完了報告の `acceptance_report[].criterion` の先頭トークンにそのまま載せる。";

/** 契約書式で受け入れ条件を渡された受託側が、 実装前後に回す手順。 */
export const ACCEPTANCE_CONTRACT_ORDER_RULE =
  "実装より先に `augur.contracts.json` と述語モジュール (契約 id ごとの判定) を書く。" +
  "契約を後から書くと「通ったことにする契約」になり、 突合が意味を失う。";

/**
 * 契約書式の受け入れ条件を検証して報告するまでの手順行。
 *
 * Augur CLI の絶対パスは端末ごとに違うので **引数で受ける** (ソースにも注入テンプレにも
 * 埋め込まない)。 開始時刻は spawn 環境へ渡した環境変数から shell 構文で展開させる。
 */
export function acceptanceContractProcedureLines(input: {
  /** 実行時に解決した Augur CLI の起動コマンド (例 `node <Augur>/bin/augur.mjs`)。 */
  augurCli: string;
  /** 委託開始時刻を持つ環境変数名 (既定 DELEGATION_STARTED_AT)。 */
  startedAtEnv?: string;
}): string[] {
  const env = input.startedAtEnv ?? "DELEGATION_STARTED_AT";
  return [
    `- ${ACCEPTANCE_CONTRACT_FORMAT_RULE}`,
    `- ${ACCEPTANCE_CONTRACT_ORDER_RULE}`,
    `- 契約を仕込む: \`${input.augurCli} inject apply --project . --rule contract-wrap --diff-base <base>\``,
    "- 実装して動かす (テストでも実行でもよい。 契約述語が 1 度も通らない項目は未充足になる)。",
    `- 集計する: \`${input.augurCli} contracts report --project . --acceptance --json --since $${env}\``,
    `  (PowerShell では \`--since $env:${env}\`)。 出力は \`[{criterion, met, note}]\`。`,
    "- その JSON をそのまま完了報告の `acceptance_report` に載せる。 自己申告 `met` が集計と",
    "  食い違う項目は `unmet acceptance` として completed が拒否される。",
  ];
}
