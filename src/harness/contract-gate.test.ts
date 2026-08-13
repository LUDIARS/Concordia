import { describe, expect, it } from "vitest";
import { contractIncomplete } from "./predicates.js";
describe("contractIncomplete", () => {
  it("denies code edits but permits contract docs", () => {
    expect(contractIncomplete({ tool: "Edit", filePath: "E:/repo/src/a.ts", contractComplete: false })?.decision).toBe("deny");
    expect(contractIncomplete({ tool: "Edit", filePath: "E:/repo/spec/a.md", contractComplete: false })).toBeNull();
  });
});
