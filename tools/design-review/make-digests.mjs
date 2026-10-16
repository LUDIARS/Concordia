import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDigestInput } from "./digest-input.mjs";
import { renderDigests } from "./digest-renderer.mjs";

/** CLI adapter: input validation completes before the first output write. */
export function makeDigests(argv) {
  const [dir, ...options] = argv;
  if (!dir || dir.startsWith("--") || options.some((o) => o !== "--allow-partial") || options.length > 1) {
    throw new Error("Usage: node make-digests.mjs <wfdir> [--allow-partial]");
  }
  const files = renderDigests(loadDigestInput(dir, { allowPartial: options.includes("--allow-partial") }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, "utf8");
  return Object.keys(files);
}
