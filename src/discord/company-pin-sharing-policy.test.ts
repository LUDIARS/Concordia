import { describe, expect, it } from "vitest";
import { canSharePinnedContent, isSharedSaveAction, sharedContent } from "./company-pin-sharing-policy.js";

const visible = { guildId: "g", sourceGuildId: "g", targetGuildId: "g", sourceChannelId: "s",
  targetChannelId: "t", privateSource: false, sourceAudience: "acl", targetAudience: "acl" };

describe("company pin sharing policy", () => {
  it("shares only the same company and readership", () => {
    expect(canSharePinnedContent(visible)).toBe(true);
    for (const change of [{ sourceGuildId: "other" }, { targetGuildId: "other" },
      { privateSource: true }, { sourceAudience: null }, { targetAudience: "broader" }, { sourceChannelId: "t" }]) {
      expect(canSharePinnedContent({ ...visible, ...change })).toBe(false);
    }
  });
  it("selects save semantics, not emoji or arbitrary workflows", () => {
    for (const action of ["memoria-note", "repo-memory-good", "repo-memory-bad"]) expect(isSharedSaveAction(action)).toBe(true);
    for (const action of ["📌", "repin", "memoria-task", "status-check", "add-as-workflow"]) expect(isSharedSaveAction(action)).toBe(false);
  });
  it("quotes short content and preserves complete long Japanese text", () => {
    expect(sharedContent("一行\n二行", "https://discord.com/channels/g/c/m", "pin").content).toContain("> 一行\n> 二行");
    const text = "長い本文📝\n".repeat(1000);
    const rendered = sharedContent(text, "url", "save");
    expect(rendered.attachmentText).toBe(text);
    expect(rendered.content).toContain("保存操作の対象");
    expect(rendered.content.length).toBeLessThanOrEqual(2000);
    expect(sharedContent("", "url", "pin").content).toContain("元の投稿");
  });
});
