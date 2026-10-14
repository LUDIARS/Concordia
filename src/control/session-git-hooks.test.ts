import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applySessionGitHooks, prepareSessionGitHooks } from "./session-git-hooks.js";

describe("prepareSessionGitHooks", () => {
  it("writes forwarding wrappers and points Git at them without editing config files", async () => {
    const dir = await prepareSessionGitHooks();
    expect(readFileSync(join(dir, "pre-commit"), "utf8")).toContain('exec node "$CONCORDIA_SESSION_HOOK_RUNNER" pre-commit');
    const env: NodeJS.ProcessEnv = {};
    applySessionGitHooks(env, dir);
    expect(env).toMatchObject({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: dir });
  });
});
