/**
 * Lictor 起動コマンド (launcher) の解決。
 *
 * spawn は `cmd /d /s /c <launcher...> <provider> [args]` で Lictor を起動する。
 * 既定の launcher は `["lictor"]` (PATH 上のグローバル lictor) だが、 環境によっては
 * PATH に lictor が無く spawn に失敗する。 設定 (AdminState) で明示できるようにする:
 *
 *   - auto : ["lictor"]                              … 従来どおり PATH 解決 (既定)
 *   - dev  : ["node", "<devPath>/bin/lictor.mjs"]    … ローカルリポを直接実行
 *   - prod : ["<prodExe>"]                           … 同梱 exe (Release 公開物)
 *
 * 解決は spawn のたびに評価される (設定変更を再起動なしで反映)。 dev/prod の
 * 必須パスが空なら auto (= bare `lictor`) にフォールバックする。
 */

import { join } from "node:path";
import type { AdminState } from "../admin/state.js";

/** AdminState の Lictor 設定から launcher トークン列を解決する。 */
export function resolveLictorLauncher(admin: AdminState): string[] {
  const mode = admin.getLictorMode();
  if (mode === "prod") {
    const exe = admin.getLictorProdExe().trim();
    if (exe) return [exe];
  } else if (mode === "dev") {
    const devPath = admin.getLictorDevPath().trim();
    if (devPath) return ["node", join(devPath, "bin", "lictor.mjs")];
  }
  return ["lictor"];
}
