import { describe, expect, it } from "vitest";
import type { DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import { resolveChannelId } from "./domain-review-post.js";

function deps(input: {
  session?: { channel_id: string; status: string } | null;
  houkoku?: string | null;
}) {
  return {
    sessionChannels: {
      findBySessionId: () => input.session ?? null,
    } as unknown as DiscordSessionChannelsRepo,
    resolveHoukokuChannelId: () => input.houkoku ?? null,
  };
}

describe("ドメインレビューの投稿先", () => {
  it("明示指定が最優先", () => {
    const resolved = resolveChannelId(
      deps({ session: { channel_id: "session-chan", status: "active" }, houkoku: "houkoku-chan" }),
      "explicit-chan",
      "sess-1",
    );
    expect(resolved).toBe("explicit-chan");
  });

  it("明示指定が無ければ active なセッション面", () => {
    expect(resolveChannelId(
      deps({ session: { channel_id: "session-chan", status: "active" }, houkoku: "houkoku-chan" }),
      null,
      "sess-1",
    )).toBe("session-chan");
  });

  it("終了したセッションのスレッドへは投げない (アーカイブされて読まれない)", () => {
    expect(resolveChannelId(
      deps({ session: { channel_id: "session-chan", status: "ended" }, houkoku: "houkoku-chan" }),
      null,
      "sess-1",
    )).toBe("houkoku-chan");
  });

  it("セッションが無ければ houkoku", () => {
    expect(resolveChannelId(deps({ houkoku: "houkoku-chan" }), null, null)).toBe("houkoku-chan");
  });

  it("どれも無ければ null (投稿しない)", () => {
    expect(resolveChannelId(deps({}), null, null)).toBeNull();
  });
});
