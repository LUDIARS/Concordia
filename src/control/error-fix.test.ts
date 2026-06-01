import { describe, it, expect } from "vitest";
import { shouldFixError, buildErrorFixPrompt } from "./error-fix.js";

describe("shouldFixError", () => {
  it("accepts vestigium service errors", () => {
    expect(shouldFixError("vestigium:memoria", "TypeError: x is not a function")).toBe(true);
  });

  it("accepts non-transient discord failures", () => {
    expect(shouldFixError("discord", "session-channel: create failed: Missing Permissions")).toBe(true);
  });

  it("rejects transient discord failures (rate limit / timeout / unavailable)", () => {
    expect(shouldFixError("discord", "rate limited")).toBe(false);
    expect(shouldFixError("discord", "cost channel update failed: ETIMEDOUT")).toBe(false);
    expect(shouldFixError("discord", "monitor channel unavailable")).toBe(false);
    expect(shouldFixError("discord", "HTTP 503 temporarily unavailable")).toBe(false);
  });

  it("never re-fixes its own (error-autofix) source — loop guard", () => {
    expect(shouldFixError("error-autofix", "anything")).toBe(false);
  });

  it("ignores unknown sources (safe default)", () => {
    expect(shouldFixError("random", "boom")).toBe(false);
  });
});

describe("buildErrorFixPrompt", () => {
  it("includes source/message and an auto-merge instruction", () => {
    const p = buildErrorFixPrompt({ source: "vestigium:actio", message: "boom", detail: { line: 42 } });
    expect(p).toContain("vestigium:actio");
    expect(p).toContain("boom");
    expect(p).toContain("自動マージ");
    expect(p).toContain("サービス \"actio\"");
  });

  it("maps discord source to Concordia repo", () => {
    const p = buildErrorFixPrompt({ source: "discord", message: "x failed" });
    expect(p).toContain("Concordia");
  });
});
