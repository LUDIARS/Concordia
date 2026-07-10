import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { startDetachedBackendRestart, type RestartChild } from "./backend-restart.js";

class FakeChild extends EventEmitter {
  unref = vi.fn();
}

describe("startDetachedBackendRestart", () => {
  it("keeps the current backend alive when child spawn emits an error", () => {
    const child = new FakeChild();
    const schedule = vi.fn();
    const exit = vi.fn();
    const error = vi.fn();
    startDetachedBackendRestart({
      cwd: "C:/repo",
      platform: "win32",
      spawnChild: () => child as RestartChild,
      schedule,
      exit,
      log: { error },
    });

    child.emit("error", new Error("spawn npm.cmd ENOENT"));

    expect(error).toHaveBeenCalledWith(expect.stringContaining("ENOENT"));
    expect(schedule).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("handles a synchronous spawn failure without throwing", () => {
    const error = vi.fn();
    expect(() => startDetachedBackendRestart({
      cwd: "C:/repo",
      spawnChild: () => { throw new Error("EINVAL"); },
      log: { error },
    })).not.toThrow();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("EINVAL"));
  });

  it("exits only after the replacement child has spawned", () => {
    const child = new FakeChild();
    const exit = vi.fn();
    const scheduled: Array<() => void> = [];
    startDetachedBackendRestart({
      cwd: "C:/repo",
      spawnChild: () => child as RestartChild,
      schedule: (callback) => {
        scheduled.push(callback);
        return {};
      },
      exit,
    });

    expect(exit).not.toHaveBeenCalled();
    child.emit("spawn");
    expect(child.unref).toHaveBeenCalledOnce();
    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
