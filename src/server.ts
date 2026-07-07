/**
 * Concordia backend entrypoint.
 */

import { createChildLogger } from "./shared/logger.js";
import { startBackend } from "./bootstrap/core.js";

export type { BackendHandle } from "./bootstrap/core.js";
export { startBackend };

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
