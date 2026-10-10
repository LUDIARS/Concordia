import { describe, expect, it, vi } from "vitest";
import { WorkingPost } from "./working-post.js";

function make(enabled = true) {
  let next = 0;
  const post = vi.fn(async () => `m${++next}`);
  const remove = vi.fn(async () => {});
  const wp = new WorkingPost({ enabled: () => enabled, post, remove });
  return { wp, post, remove };
}

describe("WorkingPost (working-indicator.md)", () => {
  it("posts once when work starts and removes it when the session goes idle", async () => {
    const { wp, post, remove } = make();
    await wp.setWorking("s1", true);
    await wp.setWorking("s1", true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(wp.hasPost("s1")).toBe(true);
    await wp.setWorking("s1", false);
    expect(remove).toHaveBeenCalledWith("s1", "m1");
    expect(wp.hasPost("s1")).toBe(false);
  });

  it("posts again for the next round of work", async () => {
    const { wp, post } = make();
    await wp.setWorking("s1", true);
    await wp.setWorking("s1", false);
    await wp.setWorking("s1", true);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("posts nothing for a department that turned the item off (エンジニア課)", async () => {
    const { wp, post, remove } = make(false);
    await wp.setWorking("s1", true);
    await wp.setWorking("s1", false);
    expect(post).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes the post when the session ends or is lost", async () => {
    const { wp, remove } = make();
    await wp.setWorking("s1", true);
    await wp.clear("s1");
    expect(remove).toHaveBeenCalledWith("s1", "m1");
    await wp.clear("unknown");
  });

  it("keeps order when start and stop arrive back to back", async () => {
    const { wp, post, remove } = make();
    void wp.setWorking("s1", true);
    await wp.setWorking("s1", false);
    expect(post).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("s1", "m1");
    expect(wp.hasPost("s1")).toBe(false);
  });

  it("keeps going after a failed post", async () => {
    const log = vi.fn();
    const post = vi.fn().mockRejectedValueOnce(new Error("429")).mockResolvedValue("m2");
    const wp = new WorkingPost({ enabled: () => true, post, remove: async () => {}, log });
    await wp.setWorking("s1", true);
    expect(log).toHaveBeenCalled();
    await wp.setWorking("s1", true);
    expect(wp.hasPost("s1")).toBe(true);
  });
});
