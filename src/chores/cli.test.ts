import { describe, expect, it } from "vitest";
import { choreCommand, choreEnvironment } from "./cli.js";
describe("one-shot CLI boundary", () => {
  it("applies shared role overrides without changing effort or output paths", () => {
    const previous = process.env.LUDIARS_ONESHOT_MODEL_LUNA;
    process.env.LUDIARS_ONESHOT_MODEL_LUNA = "gpt-6-sol";
    try {
      const { args } = choreCommand("codex", "space/result.txt", "linux");
      expect(args).toContain("gpt-6-sol");
      expect(args).toContain('model_reasoning_effort="xhigh"');
      expect(args).toContain("space/result.txt");
    } finally {
      if (previous === undefined) delete process.env.LUDIARS_ONESHOT_MODEL_LUNA;
      else process.env.LUDIARS_ONESHOT_MODEL_LUNA = previous;
    }
  });
  it("pins requested model and effort while preserving native executables and stdin", () => {
    expect(choreCommand("claude", "result.txt", "win32")).toEqual({ file: "claude.exe", args: ["-p", "--model", "claude-opus-5-5", "--effort", "medium"] });
    expect(choreCommand("codex", "dir with spaces/result.txt", "win32")).toEqual({ file: "codex.exe",
      args: ["exec", "--model", "gpt-6-luna", "-c", 'model_reasoning_effort="xhigh"', "--skip-git-repo-check", "--output-last-message", "dir with spaces/result.txt", "-"] });
    expect(choreCommand("claude", "result.txt", "darwin").file).toBe("claude");
  });
  it("removes parent coordination identity without mutating the parent", () => {
    const env = { PATH: "path", LICTOR_PORT: "123", CONCORDIA_SESSION_ID: "parent", CLAUDECODE: "1", CODEX_THREAD_ID: "parent" };
    expect(choreEnvironment(env)).toEqual({ PATH: "path" });
    expect(env.LICTOR_PORT).toBe("123");
  });
});
