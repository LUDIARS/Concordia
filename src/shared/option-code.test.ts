import { describe, expect, it } from "vitest";
import { formatOptionCode, labelWithOptionCode } from "./option-code.js";

describe("formatOptionCode", () => {
  it("uses letters for the first 26 options and one-based numbers thereafter", () => {
    expect(formatOptionCode(0)).toBe("A");
    expect(formatOptionCode(25)).toBe("Z");
    expect(formatOptionCode(26)).toBe("27");
  });

  it("marks invalid indexes instead of producing a misleading option code", () => {
    expect(formatOptionCode(-1)).toBe("?");
    expect(formatOptionCode(1.5)).toBe("?");
  });
});

describe("labelWithOptionCode", () => {
  it("places the code before the original label", () => {
    expect(labelWithOptionCode(1, "Proceed")).toBe("[B] Proceed");
  });
});
