import { describe, expect, it } from "vitest";
import { choreCommand, choreEnvironment } from "./cli.js";
describe("one-shot CLI boundary", () => {
  it("pins requested model and effort while preserving native executables and stdin", () => {
    expect(choreCommand("claude", "result.txt", "win32")).toEqual({ file: "claude.exe", args: ["-p", "--model", "claude-opus-5-5", "--effort", "medium"] });
    expect(choreCommand("codex", "dir with spaces/result.txt", "win32")).toEqual({ file: "codex.exe",
      args: ["exec", "--model", "gpt-5.6-terra", "-c", 'model_reasoning_effort="xhigh"', "--skip-git-repo-check", "--output-last-message", "dir with spaces/result.txt", "-"] });
    expect(choreCommand("claude", "result.txt", "darwin").file).toBe("claude");
  });
  it("removes parent coordination identity without mutating the parent", () => {
    const env = { PATH: "path", LICTOR_PORT: "123", CONCORDIA_SESSION_ID: "parent", CLAUDECODE: "1", CODEX_THREAD_ID: "parent" };
    expect(choreEnvironment(env)).toEqual({ PATH: "path" });
    expect(env.LICTOR_PORT).toBe("123");
  });
});
