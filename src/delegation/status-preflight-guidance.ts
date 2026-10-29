import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

/** Resolve the Cc checkout, since a delegated session may work in another repository. */
export function buildStatusPreflightGuidance(): string {
  const checkout = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
  return `送信前に UTF-8 JSON ファイルを検査: npm --prefix "${checkout}" run delegation:status:preflight -- "<report.json の絶対パス>"。exit 0 のときだけ同じファイルを送信します。detail/result は各 4000 UTF-16 code unit 以下（絵文字等は 2）。成功は入力構造の確認だけで、完了証跡・認可・終端遷移は API が判定します。`;
}
