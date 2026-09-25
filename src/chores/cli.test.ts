import { describe, expect, it } from "vitest";
import { choreCommand, choreEnvironment } from "./cli.js";
describe("one-shot CLI boundary", () => {
  it("uses native executables and stdin rather than a shell command", () => {
    expect(choreCommand("claude", "result.txt", "win32")).toEqual({ file: "claude.exe", args: ["-p"] });
    expect(choreCommand("codex", "dir with spaces/result.txt", "win32")).toEqual({ file: "codex.exe",
      args: ["exec", "--skip-git-repo-check", "--output-last-message", "dir with spaces/result.txt", "-"] });
    expect(choreCommand("claude", "result.txt", "darwin").file).toBe("claude");
  });
  it("removes parent coordination identity without mutating the parent", () => {
    const env = { PATH: "path", LICTOR_PORT: "123", CONCORDIA_SESSION_ID: "parent", CLAUDECODE: "1", CODEX_THREAD_ID: "parent" };
    expect(choreEnvironment(env)).toEqual({ PATH: "path" });
    expect(env.LICTOR_PORT).toBe("123");
  });
});
