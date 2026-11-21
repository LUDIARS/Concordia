import { describe, expect, it } from "vitest";
import { SESSION_PLAN_CLI, sessionPlanGuidance } from "./plan-guidance.js";

describe("session plan guidance", () => {
  it("tells agy when and how to send the plan through the CLI", () => {
    const text = sessionPlanGuidance("antigravity-cli", "E:/c/tools/session-plan.mjs");
    expect(text).toContain("複数の手順がある作業は、 着手前にプランを送って");
    expect(text).toContain("短い返答や 1 手順で済む作業はプラン不要");
    expect(text).toContain('node "E:/c/tools/session-plan.mjs" update --file=');
    expect(text).toContain('node "E:/c/tools/session-plan.mjs" wrap-up');
    expect(text).toContain("非 0 で終わったら");
  });

  it("adds nothing for Claude Code and the other providers", () => {
    for (const provider of ["claude-code", "codex-cli", "gemini-cli", "unknown"]) expect(sessionPlanGuidance(provider)).toBe("");
  });

  it("points at the CLI that ships with this checkout", () => {
    expect(SESSION_PLAN_CLI).toMatch(/\/tools\/session-plan\.mjs$/);
  });
});
