import { describe, it, expect, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { FULLTEXT_SCROLL, patchCanalisFetcher } from "./patch-canalis-notion.mjs";

describe("Canalis full-text completion guard", () => {
  const scroll = () => runInNewContext(FULLTEXT_SCROLL + "\nscrollToBottom");
  it("rejects continuous growth instead of treating a clipped page as unchanged", async () => {
    let height = 1;
    const page = { evaluate: async () => height++, waitForTimeout: async () => undefined };
    await expect(scroll()(page, 1, 3)).rejects.toThrow(/scroll limit/);
  });
  it("requires two stable observations and returns to the top", async () => {
    const page = { evaluate: vi.fn(async () => 100), waitForTimeout: vi.fn(async () => undefined) };
    await scroll()(page, 1, 3);
    expect(page.waitForTimeout).toHaveBeenCalledTimes(2);
    expect(page.evaluate).toHaveBeenCalledTimes(7);
  });
  it("refuses unrecognized dependency output instead of applying an unsafe patch", () => {
    expect(() => patchCanalisFetcher("unexpected upstream version")).toThrow(/changed/);
  });
});
