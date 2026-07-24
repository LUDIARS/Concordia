import { describe, expect, it } from "vitest";
import { recoverCollapsedWindowsWorkspacePath } from "./windows-path-recovery.js";

describe("recoverCollapsedWindowsWorkspacePath", () => {
  const workspace = "E:\\Document\\Ars";
  const project = "E:\\Document\\Ars\\Concordia";

  it("preserves a valid Windows path", () => {
    expect(recoverCollapsedWindowsWorkspacePath(project, [workspace], () => true)).toBe(project);
  });

  it("recovers a collapsed direct workspace child when it exists", () => {
    expect(
      recoverCollapsedWindowsWorkspacePath("E:DocumentArsConcordia", [workspace], (path) => path === project),
    ).toBe(project);
  });

  it("recovers a collapsed configured root", () => {
    expect(
      recoverCollapsedWindowsWorkspacePath("E:DocumentArsConcordia", [project], (path) => path === project),
    ).toBe(project);
  });

  it("does not guess an absent or ambiguous path", () => {
    expect(
      recoverCollapsedWindowsWorkspacePath("E:DocumentArsNestedConcordia", [workspace], () => false),
    ).toBe("E:DocumentArsNestedConcordia");
  });
});
