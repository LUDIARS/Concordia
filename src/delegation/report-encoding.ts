/**
 * 委託先から届く報告本文の文字化け検出。
 *
 * 委託先は Windows 上の CLI から `POST /v1/delegation/runs/:id/status` を叩く。
 * シェルに日本語を直書きすると CP932 のバイト列が UTF-8 として送られ、 デコード時に
 * 不正バイトが U+FFFD (REPLACEMENT CHARACTER) へ潰れる。 **この時点で原文は失われて
 * いる** ので、 受け取り側で復元することはできない。
 *
 * それでも黙って受けると、 残作業が `writeRemainingTasks` で spec/tasks の md になり、
 * reconciler 経由で Memoria のタスクとして永続化される。 化けたまま台帳へ入ると
 * 「何の残作業か分からないタスク」 が残り、 誰も直せない。
 *
 * そこで **報告の受理時に落として、 送り直させる**。 失われた情報を推測で埋めるより、
 * 送信側が body をファイル経由で送り直すほうが確実で速い。
 */

/** UTF-8 デコードに失敗したバイトの置換文字。 これが本文にあれば原文は既に壊れている。 */
const REPLACEMENT_CHARACTER = "�";

/** 送信側が次に取るべき手順。 エラー本文にそのまま載せる。 */
export const GARBLED_REPORT_HINT =
  "報告本文が文字化けしています (UTF-8 として読めないバイトが含まれていました)。"
  + " Windows の一部のシェル経路では、日本語を直書きすると CP932 のまま送られて壊れます。"
  + " JSON body を UTF-8 のファイルに書き、 curl.exe の --data-binary @<file> で送り直してください。";

/**
 * 文字化けしている文字列フィールドのパスを列挙する。 空配列 = 問題なし。
 * 配列要素は `remaining[0].title` のように添字付きで返す (どれを直せばよいか分かる)。
 *
 * @implements SPEC-DELEGATION-STATUS-UTF8
 */
export function findGarbledReportFields(report: {
  detail?: string | undefined;
  result?: string | undefined;
  remaining?: ReadonlyArray<{
    title: string;
    note?: string | undefined;
    scope_dirs?: readonly string[] | undefined;
  }> | undefined;
  acceptance_report?: ReadonlyArray<{ criterion: string; note?: string | undefined }> | undefined;
}): string[] {
  const garbled: string[] = [];
  if (report.detail?.includes(REPLACEMENT_CHARACTER)) garbled.push("detail");
  if (report.result?.includes(REPLACEMENT_CHARACTER)) garbled.push("result");
  for (const [index, item] of report.remaining?.entries() ?? []) {
    if (item.title.includes(REPLACEMENT_CHARACTER)) garbled.push(`remaining[${index}].title`);
    if (item.note?.includes(REPLACEMENT_CHARACTER)) garbled.push(`remaining[${index}].note`);
    for (const [scopeIndex, scopeDir] of item.scope_dirs?.entries() ?? []) {
      if (scopeDir.includes(REPLACEMENT_CHARACTER)) {
        garbled.push(`remaining[${index}].scope_dirs[${scopeIndex}]`);
      }
    }
  }
  for (const [index, item] of report.acceptance_report?.entries() ?? []) {
    if (item.criterion.includes(REPLACEMENT_CHARACTER)) garbled.push(`acceptance_report[${index}].criterion`);
    if (item.note?.includes(REPLACEMENT_CHARACTER)) garbled.push(`acceptance_report[${index}].note`);
  }
  return garbled;
}
