import { describe, expect, it } from "vitest";
import { buildForumThreadTitle, forumWorkPhase, withForumWorkPhase } from "./forum-title.js";

describe("forum work phase titles", () => {
  it.each([
    ["design", "設計"], ["confirmation", "確認"], ["implementation", "実装"],
    ["adjustment", "調整"], ["unknown", "未確認"],
  ] as const)("renders and reads %s", (phase, label) => {
    const title = buildForumThreadTitle("Cc", "作業名", "🌟", phase);
    expect(title).toBe(`🌟 [Cc] [${label}] 作業名`);
    expect(forumWorkPhase(title)).toBe(phase);
  });
  it("migrates old names and preserves a manually locked summary", () => {
    expect(withForumWorkPhase("🌟 [Cc] 手動の名前 [確認]", "implementation"))
      .toBe("🌟 [Cc] [実装] 手動の名前 [確認]");
    expect(withForumWorkPhase("🌟 [Cc] [実装] 手動の名前 [確認]", "adjustment"))
      .toBe("🌟 [Cc] [調整] 手動の名前 [確認]");
    expect(withForumWorkPhase("unmanaged name", "design")).toBe("unmanaged name");
  });
  it("keeps the prefix visible within 100 characters without duplicating it", () => {
    const title = buildForumThreadTitle("Cc", "長".repeat(200), "🌟", "implementation");
    expect(title).toHaveLength(100);
    expect(title.startsWith("🌟 [Cc] [実装] ")).toBe(true);
    expect(withForumWorkPhase(title, "implementation")).toBe(title);
  });
});
