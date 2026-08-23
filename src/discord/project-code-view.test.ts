import { describe, expect, it } from "vitest";
import { clipProjectCodeList } from "./project-code-view.js";

describe("clipProjectCodeList", () => {
  it("preserves short lists", () => {
    expect(clipProjectCodeList("`Cc` Concordia", 100)).toBe("`Cc` Concordia");
  });

  it("stays inside Discord limits and reports truncation", () => {
    const result = clipProjectCodeList("x".repeat(100), 40);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).toContain("一部を省略");
  });
});
