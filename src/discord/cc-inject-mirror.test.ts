import { describe, expect, it } from "vitest";
import {
  CC_INJECT_MIRROR_MAX_CONTENT,
  CC_INJECT_MIRROR_MAX_USERNAME,
  STALL_NUDGE_INJECT_SOURCE,
  ccInjectMirrorPost,
} from "./cc-inject-mirror.js";

describe("ccInjectMirrorPost", () => {
  it.each([
    "session-work-policy",
    "testing-traffic",
    "delegation:run-1:status",
  ])("mirrors Cc-originated inject (source=%s)", (source) => {
    expect(ccInjectMirrorPost({ source, text: "  hello  " })).toEqual({
      username: `⚙️ Cc inject / ${source}`,
      content: "hello",
    });
  });

  it("labels a missing source as unknown", () => {
    expect(ccInjectMirrorPost({ source: undefined, text: "x" })?.username).toBe("⚙️ Cc inject / unknown");
    expect(ccInjectMirrorPost({ source: "", text: "x" })?.username).toBe("⚙️ Cc inject / unknown");
  });

  it.each(["discord", "discord-enter", "discord:123456789012345678"])(
    "skips Discord-originated inject (source=%s)",
    (source) => {
      expect(ccInjectMirrorPost({ source, text: "hi" })).toBeNull();
    },
  );

  it("skips Slack human inject (mirrored by the existing Slack path)", () => {
    expect(ccInjectMirrorPost({ source: "slack:U123", text: "hi" })).toBeNull();
  });

  it.each(["delegation:run-1:followup", "delegation:run-1:parent", "delegation:run-1:followup-memoria"])(
    "skips delegation task body inject (source=%s)",
    (source) => {
      expect(ccInjectMirrorPost({ source, text: "task" })).toBeNull();
    },
  );

  it("skips stall nudge inject", () => {
    expect(STALL_NUDGE_INJECT_SOURCE).toBe("auto:stall-nudge");
    expect(ccInjectMirrorPost({ source: STALL_NUDGE_INJECT_SOURCE, text: "nudge" })).toBeNull();
  });

  it("skips control inject (Enter key) and blank text", () => {
    expect(ccInjectMirrorPost({ source: "session-work-policy", text: "\r" })).toBeNull();
    expect(ccInjectMirrorPost({ source: "session-work-policy", text: "  \n " })).toBeNull();
  });

  it("truncates long content to the Discord-safe limit with a suffix", () => {
    const post = ccInjectMirrorPost({ source: "auto:inquiry", text: "a".repeat(2500) });
    expect(post?.content.length).toBe(CC_INJECT_MIRROR_MAX_CONTENT);
    expect(post?.content.endsWith("\n…(以下省略)")).toBe(true);
  });

  it("keeps content at exactly the limit untouched", () => {
    const text = "b".repeat(CC_INJECT_MIRROR_MAX_CONTENT);
    expect(ccInjectMirrorPost({ source: "auto:inquiry", text })?.content).toBe(text);
  });

  it("caps username at 80 characters", () => {
    const post = ccInjectMirrorPost({ source: `reaction:${"x".repeat(200)}`, text: "hi" });
    expect(post?.username.length).toBe(CC_INJECT_MIRROR_MAX_USERNAME);
    expect(post?.username.startsWith("⚙️ Cc inject / reaction:")).toBe(true);
  });
});
