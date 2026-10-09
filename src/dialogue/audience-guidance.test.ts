import { describe, expect, it } from "vitest";
import { parseDepartmentSettings } from "../departments/settings.js";
import { audienceGuidanceBlock } from "./audience-guidance.js";

describe("audienceGuidanceBlock (departments.md §9.8)", () => {
  it("adds nothing for the standard audience", () => {
    expect(audienceGuidanceBlock("standard")).toBeNull();
  });

  it("asks non-engineer departments for plain words and the three closing items", () => {
    const block = audienceGuidanceBlock("non-engineer")!;
    expect(block.startsWith("### 話し方: 非エンジニア向け")).toBe(true);
    for (const item of ["やったこと", "決めてほしいこと", "残っていること"]) expect(block).toContain(`  - ${item}`);
    // 形の決まった出力と作業規則は崩さない。
    expect(block).toContain("ask マーカー");
    expect(block).toContain("作業規則・承認");
  });
});

describe("department audience setting", () => {
  it("defaults existing settings to the standard audience", () => {
    expect(parseDepartmentSettings("{}").audience).toBe("standard");
  });

  it("accepts non-engineer and rejects unknown values", () => {
    expect(parseDepartmentSettings(JSON.stringify({ audience: "non-engineer" })).audience).toBe("non-engineer");
    expect(() => parseDepartmentSettings(JSON.stringify({ audience: "kids" }))).toThrow();
  });
});
