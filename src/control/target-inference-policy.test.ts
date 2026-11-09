import { describe, expect, it } from "vitest";
import { mayInferTargetProjectFromText } from "./target-inference-policy.js";

const roots = ["D:\\LUDIARS"];

describe("mayInferTargetProjectFromText", () => {
  it("allows inference for a session started at the workspace root", () => {
    expect(mayInferTargetProjectFromText("D:\\LUDIARS", roots)).toBe(true);
    expect(mayInferTargetProjectFromText("d:/ludiars/", roots)).toBe(true);
  });

  it("allows inference when the session has no repository yet", () => {
    expect(mayInferTargetProjectFromText("", roots)).toBe(true);
    expect(mayInferTargetProjectFromText(null, roots)).toBe(true);
    expect(mayInferTargetProjectFromText(undefined, roots)).toBe(true);
  });

  it("refuses inference for a session working in a specific repository", () => {
    expect(mayInferTargetProjectFromText("D:\\LUDIARS\\Cernere", roots)).toBe(false);
  });

  it("refuses inference for a session working in a linked worktree", () => {
    expect(mayInferTargetProjectFromText("D:\\LUDIARS\\.wt-Cernere-presence", roots)).toBe(false);
  });

  it("refuses inference for a specific repository when no workspace root is configured", () => {
    expect(mayInferTargetProjectFromText("D:\\LUDIARS\\Cernere", [])).toBe(false);
  });
});
