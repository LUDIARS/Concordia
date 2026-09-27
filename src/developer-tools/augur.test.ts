import { describe, expect, it, vi } from "vitest";
import { AugurTools } from "./augur.js";

describe("Augur result semantics", () => {
  function fixture(stdout: string, code = 0) {
    const runner = vi.fn(async () => ({ stdout, code }));
    const tools = new AugurTools(() => [], runner);
    vi.spyOn(tools, "cli").mockReturnValue("/Augur/bin/augur.mjs");
    return { tools, runner };
  }
  it("does not mistake exit zero with failed tests for a pass", async () => {
    const { tools, runner } = fixture('{"status":"failed"}');
    expect(await tools.run("/repo", "all", "abc")).toMatchObject({ passed: false });
    expect(runner).toHaveBeenCalledWith("/Augur/bin/augur.mjs", expect.arrayContaining(["--no-promote", "--head", "abc"]), "/repo", expect.any(AbortSignal));
  });
  it("rejects empty bundles", async () => {
    const { tools } = fixture('{"empty":true}', 3);
    await expect(tools.run("/repo", "all", "abc")).rejects.toThrow("test_bundle_empty");
  });
  it("returns the recorded passing result", async () => {
    const { tools } = fixture('{"status":"passed","runId":"run-one"}');
    expect(await tools.run("/repo", "all", "abc")).toMatchObject({ passed: true, run: { runId: "run-one" } });
  });
});
