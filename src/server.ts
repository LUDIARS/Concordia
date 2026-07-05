/**
 * Concordia backend entrypoint.
 */

import { createChildLogger } from "./shared/logger.js";
import { startBackend } from "./bootstrap/core.js";

export type { BackendHandle } from "./bootstrap/core.js";
export { startBackend };

const log = createChildLogger("server");

function isEntrypoint(): boolean {
  const argv1 = process.argv[1] ?? "";
  if (!argv1) return false;
  const norm = argv1.replace(/\\/g, "/");
  const url = import.meta.url;
  return url === `file://${norm}` || url === `file:///${norm}` || url.endsWith(norm);
}

if (isEntrypoint()) {
  startBackend().catch((err) => {
    log.error({ err }, "Concordia failed to start");
    process.exit(1);
  });
}
