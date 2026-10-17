import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { spawn } from "node:child_process";
import { createCloudGitCommand } from "./git-process.js";
const spawnMock = vi.fn();
const runCloudGit = createCloudGitCommand(spawnMock as unknown as typeof spawn);

function processFixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  spawnMock.mockReturnValue(child);
  return child;
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); spawnMock.mockReset(); });
describe("bounded Git subprocess", () => {
  it("preserves binary output and removes inherited Git routing", async () => {
    vi.stubEnv("GIT_DIR", "unrelated-repo");
    const child = processFixture();
    const pending = runCloudGit("isolated", ["receive-pack", "."], Buffer.from([0, 255]));
    child.stdout.write(Buffer.from([255, 0, 13, 10]));
    child.emit("close", 0);
    await expect(pending).resolves.toEqual(Buffer.from([255, 0, 13, 10]));
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ cwd: "isolated", shell: false, windowsHide: true });
    expect(spawnMock.mock.calls[0]?.[2].env.GIT_DIR).toBeUndefined();
  });
  it("kills an oversized producer and rejects after closure", async () => {
    const child = processFixture();
    const pending = runCloudGit("isolated", []);
    child.stdout.write(Buffer.alloc(1_048_577));
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit("close", 0);
    await expect(pending).rejects.toThrow("cloud_git_process_failed");
  });
  it("terminates overdue work and clears its timer", async () => {
    vi.useFakeTimers();
    const child = processFixture();
    const pending = runCloudGit("isolated", []);
    vi.advanceTimersByTime(60_000);
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit("close", null);
    await expect(pending).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("hides process error details", async () => {
    const child = processFixture();
    const pending = runCloudGit("isolated", []);
    child.emit("error", new Error("secret path"));
    await expect(pending).rejects.toThrow("cloud_git_process_failed");
  });
});
