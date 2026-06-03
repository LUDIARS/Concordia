import { describe, it, expect } from "vitest";
import { chatChannelToMetaKind, metaKindToChatChannel, META_CHANNEL_KIND } from "./types.js";

describe("boyaki channel routing", () => {
  it("maps ChatChannel 'ぼやき' to Discord meta kind 'boyaki'", () => {
    expect(chatChannelToMetaKind("ぼやき")).toBe("boyaki");
  });

  it("maps Discord meta kind 'boyaki' back to ChatChannel 'ぼやき'", () => {
    expect(metaKindToChatChannel("boyaki")).toBe("ぼやき");
  });

  it("round-trips boyaki without loss", () => {
    const kind = chatChannelToMetaKind("ぼやき");
    expect(kind).not.toBeNull();
    expect(metaKindToChatChannel(kind!)).toBe("ぼやき");
  });

  it("includes boyaki in META_CHANNEL_KIND so a Discord channel is provisioned", () => {
    expect(META_CHANNEL_KIND).toContain("boyaki");
  });

  it("keeps existing channel mappings intact", () => {
    expect(chatChannelToMetaKind("報告")).toBe("houkoku");
    expect(metaKindToChatChannel("houkoku")).toBe("報告");
    expect(chatChannelToMetaKind("system")).toBe("system");
  });
});
