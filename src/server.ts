/**
 * Concordia backend entrypoint.
 */

import { createChildLogger } from "./shared/logger.js";
import { startBackend } from "./bootstrap/core.js";
import { reportError } from "./errors.js";

export type { BackendHandle } from "./bootstrap/core.js";
export { startBackend };

/**
 * プロセスレベルの安全網。 Concordia は全セッションの管制塔なので、 取りこぼした
 * rejection 1 発でプロセスごと死ぬ (Node 既定動作) と全セッションが同時にロスト
 * したように見える。 ここで捕捉してログ + error.reported へ流し、 プロセスは
 * 生かし続ける。 uncaughtException 後の状態は保証されないが、 管制塔の即死より
 * 「継続 + errors チャンネルで可視化」 を優先する。
 */
export function installProcessSafetyNet(): void {
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    log.error({ err }, "unhandled promise rejection (kept alive)");
    reportError("process", `unhandledRejection: ${err.message}`, { stack: err.stack });
  });
  process.on("uncaughtException", (err) => {
    log.error({ err }, "uncaught exception (kept alive)");
    reportError("process", `uncaughtException: ${err.message}`, { stack: err.stack });
  });
}

const log = createChildLogger("server");
let activeHandle: Awaited<ReturnType<typeof startBackend>> | null = null;

function isEntrypoint(): boolean {
  const argv1 = process.argv[1] ?? "";
  if (!argv1) return false;
  const norm = argv1.replace(/\\/g, "/");
  const url = import.meta.url;
  return url === `file://${norm}` || url === `file:///${norm}` || url.endsWith(norm);
}

if (isEntrypoint()) {
  installProcessSafetyNet();
  log.info(
    { version: process.env.EXCUBITOR_SERVICE_VERSION ?? "unavailable" },
    "Concordia runtime version",
  );
  process.on("beforeExit", (code) => {
    log.warn({ code, hasHandle: activeHandle !== null }, "Concordia process beforeExit");
  });
  startBackend()
    .then((handle) => {
      activeHandle = handle;
    })
    .catch((err) => {
      log.error({ err }, "Concordia failed to start");
      process.exit(1);
    });
}
