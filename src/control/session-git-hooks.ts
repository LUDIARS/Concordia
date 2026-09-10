/** @implements spec/feature/shared-startup-context.md — new-session Git hook transport */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HOOKS = ["applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit",
  "prepare-commit-msg", "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge",
  "pre-push", "pre-auto-gc", "post-rewrite", "reference-transaction", "post-index-change", "fsmonitor-watchman"];

/** Reusable wrappers forward existing hooks; no repository/global Git config is edited. */
export function prepareSessionGitHooks(): string {
  const runner = fileURLToPath(new URL("../../tools/session-git-hook.mjs", import.meta.url));
  const key = createHash("sha256").update(runner).digest("hex").slice(0, 16);
  const dir = join(tmpdir(), "concordia-session-hooks", key);
  mkdirSync(dir, { recursive: true });
  for (const hook of HOOKS) {
    writeFileSync(join(dir, hook), `#!/bin/sh\nexec node "$CONCORDIA_SESSION_HOOK_RUNNER" ${hook} "$@"\n`, { encoding: "utf8", mode: 0o755 });
  }
  return dir;
}

export function applySessionGitHooks(env: NodeJS.ProcessEnv, dir: string): void {
  const count = Number(env.GIT_CONFIG_COUNT ?? "0");
  if (!Number.isInteger(count) || count < 0 || count > 64) throw new Error("Invalid inherited Git configuration count");
  env.CONCORDIA_SESSION_HOOK_RUNNER = fileURLToPath(new URL("../../tools/session-git-hook.mjs", import.meta.url));
  env.CONCORDIA_SESSION_HOOK_CONFIG_INDEX = String(count);
  env[`GIT_CONFIG_KEY_${count}`] = "core.hooksPath";
  env[`GIT_CONFIG_VALUE_${count}`] = dir;
  env.GIT_CONFIG_COUNT = String(count + 1);
}
