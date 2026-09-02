import { describe, expect, it } from "vitest";
import {
  META_CHANNEL_KIND,
  chatChannelToMetaKind,
  metaKindToChatChannel,
  readDiscordEnv,
} from "./types.js";

describe("readDiscordEnv forum migration", () => {
  it("enables forum mode by default in Phase 3", () => {
    expect(readDiscordEnv({}).forumMode).toBe(true);
  });

  it("keeps an explicit rollback switch", () => {
    expect(readDiscordEnv({ CONCORDIA_DISCORD_FORUM_MODE: "0" }).forumMode).toBe(false);
  });
});

describe("genius meta channel", () => {
  it("is a known meta channel kind", () => {
    expect(META_CHANNEL_KIND).toContain("genius");
  });

  it("round-trips between chat channel and meta kind", () => {
    // genius は ASCII なので 報告/ぼやき と違い変換は素通し。 往復で崩れないことを
    // 押さえておかないと、 egress が meta channel を引けず投稿が迷子になる。
    expect(chatChannelToMetaKind("genius")).toBe("genius");
    expect(metaKindToChatChannel("genius")).toBe("genius");
  });

  it("keeps every chat channel mappable", () => {
    for (const channel of ["chitchat", "consultation", "報告", "ぼやき", "system", "genius"] as const) {
      expect(chatChannelToMetaKind(channel)).not.toBeNull();
    }
  });
});
