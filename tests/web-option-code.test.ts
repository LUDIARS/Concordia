import { describe, expect, it } from "vitest";
import { formatOptionCode, labelWithOptionCode } from "../web/src/lib/option-code.js";
import { formatOptionCode as formatServerOptionCode } from "../src/shared/option-code.js";

describe("web option codes", () => {
  it("matches the server display rule", () => {
    for (const index of [-1, 0, 25, 26, 100]) {
      expect(formatOptionCode(index)).toBe(formatServerOptionCode(index));
    }
    expect(labelWithOptionCode(1, "Proceed")).toBe("[B] Proceed");
  });
});
