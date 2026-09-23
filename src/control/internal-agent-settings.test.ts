import { describe, expect, it, vi } from "vitest";
import { withInternalAgentSettings, prepareInternalAgentPlugin } from "./internal-agent-settings.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
describe("Cc launch-only Agent settings", () => {
  it("does not prepare any settings for non-Claude sessions", () => {
    const prepare = vi.fn();
    expect(withInternalAgentSettings("codex", ["--model", "sol"], prepare)).toEqual(["--model", "sol"]);
    expect(prepare).not.toHaveBeenCalled();
  });
  it("preserves Lictor/user settings and the positional prompt", () => {
    const args = ["--settings", "user.json", "task prompt"];
    expect(withInternalAgentSettings("claude", args, () => "plugin")).toEqual(["--plugin-dir=plugin", ...args]);
    expect(args).toEqual(["--settings", "user.json", "task prompt"]);
  });
  it("merges an existing variadic plugin flag", () => {
    expect(withInternalAgentSettings("claude", ["--plugin-dir", "other", "--model", "opus"], () => "plugin"))
      .toEqual(["--plugin-dir", "plugin", "other", "--model", "opus"]);
  });
  it("combines an equals-form plugin option", () => {
    expect(withInternalAgentSettings("claude", ["--plugin-dir=other", "--model", "opus"], () => "plugin"))
      .toEqual(["--plugin-dir", "plugin", "other", "--model", "opus"]);
  });
  it("prepares only the Agent/Task pre-tool hook", () => {
    const dir = prepareInternalAgentPlugin();
    const settings = JSON.parse(readFileSync(join(dir, "hooks", "hooks.json"), "utf8"));
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Agent|Task");
    expect(settings.hooks.PreToolUse[0].hooks[0].timeout).toBe(20);
    expect(settings).not.toHaveProperty("permissions");
  });
});
