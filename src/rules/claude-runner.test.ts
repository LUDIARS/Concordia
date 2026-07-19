import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * runClaude の git-bash 候補パス解決 (Windows) が
 * - fs/promises 経由の async access を使う (同期 existsSync を使わない)
 * - 1 度解決したら以後 access を呼ばずメモ化する
 * ことを検証する (id 538 A-5: spawn 経路の existsSync 除去)。
 *
 * spawn 自体はモックし、 実際に claude CLI を起動しない。
 */

const accessMock = vi.fn<(path: string) => Promise<void>>();

vi.mock("node:fs/promises", () => ({
  access: (path: string) => accessMock(path),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const emitter = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: (event: string, cb: (...args: unknown[]) => void) => {
        (listeners[event] ??= []).push(cb);
        return emitter;
      },
      stdin: { end: vi.fn(), write: vi.fn() },
    };
    // close 済み (exit_code 0) を次 tick で通知して runClaude の Promise を解決させる.
    queueMicrotask(() => listeners.close?.forEach((cb) => cb(0)));
    return emitter;
  }),
}));

vi.mock("../cost/one-shot-recorder.js", () => ({
  recordLocalOneShot: vi.fn(),
}));

describe("resolveGitBashPath (via runClaude on win32)", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
    accessMock.mockReset();
    Object.defineProperty(process, "platform", { value: "win32" });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("最初の候補が存在すればそれを使い、以後は access を呼び直さない", async () => {
    accessMock.mockImplementation(async (path: string) => {
      if (path === "C:\\Program Files\\Git\\bin\\bash.exe") return;
      throw new Error("ENOENT");
    });
    const { runClaude } = await import("./claude-runner.js");

    await runClaude("hello");
    await runClaude("hello again");

    expect(accessMock).toHaveBeenCalledTimes(1);
    expect(accessMock).toHaveBeenCalledWith("C:\\Program Files\\Git\\bin\\bash.exe");
  });

  it("両候補とも無ければ null にメモ化し、以後も再探索しない", async () => {
    accessMock.mockImplementation(async () => {
      throw new Error("ENOENT");
    });
    const { runClaude } = await import("./claude-runner.js");

    await runClaude("hello");
    await runClaude("hello again");

    expect(accessMock).toHaveBeenCalledTimes(2); // 1 回目の探索で両候補を試す
  });

  it("CLAUDE_CODE_GIT_BASH_PATH が既に env にあれば access を呼ばない", async () => {
    process.env.CLAUDE_CODE_GIT_BASH_PATH = "C:\\custom\\bash.exe";
    try {
      const { runClaude } = await import("./claude-runner.js");
      await runClaude("hello");
      expect(accessMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
    }
  });
});
