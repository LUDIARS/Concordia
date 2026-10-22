import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tryStartCloudForum } from "./cloud-forum-runtime.js";

const input = (root: string, warn = vi.fn()) => ({
  root,
  guild: {} as never,
  forumId: "forum-1",
  config: {} as never,
  allowed: () => true,
  warn,
});

describe("tryStartCloudForum", () => {
  it("returns null and warns instead of throwing when the observation root is missing", () => {
    const warn = vi.fn();
    const missing = path.join(os.tmpdir(), `cloud-forum-missing-${process.pid}-${Date.now()}`);
    expect(tryStartCloudForum(input(missing, warn))).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Cloud forum disabled"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(missing));
  });

  it("returns what the start gave when it succeeds", () => {
    const started = { handles: () => false, answer: async () => {}, stop: async () => {} };
    const start = vi.fn(() => started);
    expect(tryStartCloudForum(input("/root"), start)).toBe(started);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
