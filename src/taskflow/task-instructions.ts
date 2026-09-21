/**
 * タスク分解を促す inject / ハーネスルール / inject マニュアルで共有する規範文言。
 *
 * v3.0 は Actio を本文・タスク状態の正本とする。Cc は参照と実行関連を管理する。
 * 既存 consumer の export 名は互換のため維持するが、Markdown 保存を指示しない。
 *
 * 文言を 1 箇所に集約するのは、 inject 経路 (decompose / residual)・ハーネス builtin
 * ルール・kind 別 inject マニュアルで規範がずれるのを防ぐため。
 *
 * @implements spec/feature/task-workflow-v3.md
 */

/** Content registration/retrieval instructions (legacy export name). */
export const TASK_MD_CONTENT_RULE =
  "タスクワークフロー v3.0: タスク本文は Actio に記録する。" +
  "POST /v1/taskflow/tasks に session_id・固定 request_id(UUID)・title・body・kind・memory_links を送る。" +
  "応答の actio:<id> を参照し、必要時だけ GET /v1/taskflow/tasks/content?session_id=<自分>&reference=actio:<id> で読む。" +
  "タスク本文をファイル・Cc のメモリ・PR・ログへ自動複製しない。Actio が利用できなければ停止して報告する。";

/** Actio business state and Cc execution associations (legacy export name). */
export const TASK_STATE_DB_RULE =
  "タスク本文とタスク状態の正本は Actio。Cc は Actio ID と session/run/PR の実行関連を管理する。" +
  "状態更新は PATCH /v1/taskflow/tasks/state に repo_path・task_path=actio:<id>・status を送る。";

/**
 * kind 別 inject マニュアル向けの短縮版。 マニュアルは 1 行の手順文の中に収める必要があり
 * `TASK_STATE_DB_RULE` の列挙をそのまま置くと長すぎるため、 同じ規範を要約した別文を持つ。
 *
 * 過去 migration の文言は db/taskflow-v2-instructions.ts に固定し、v3 移行は migration 110 で行う。
 * seed (`inject-manual-seed.ts`) は既存行を上書きしないので、 稼働中 DB の既定行は migration が
 * 書いた文字列のまま残る。 ここを変えるだけでは既存 DB に反映されない — 文言を変えるときは
 * 既定行を差し替える migration を別途足すこと (適用済み migration は書き換えない)。
 */
export const TASK_STATE_DB_RULE_SHORT =
  "タスク本文・状態は Actio が正本。Cc は参照と実行関連だけを保持し、タスクファイルを作成しない。";

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
