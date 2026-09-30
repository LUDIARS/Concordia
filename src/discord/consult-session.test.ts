import { ChannelType } from "discord.js";
import type { Guild } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { bindPrivateConsultSession, privateConsultPrompt, PRIVATE_CONSULT_NAME_BODY } from "./consult-session.js";

function deps(channel: unknown) {
  const upsert = vi.fn();
  const getForSession = vi.fn(async () => ({ id: "wh-1" }));
  const guild = { channels: { fetch: vi.fn(async () => channel) } } as unknown as Guild;
  return { guild, repo: { upsert }, webhooks: { getForSession }, log: { info: vi.fn(), warn: vi.fn() } };
}

describe("bindPrivateConsultSession", () => {
  it("binds the session to the consultation channel itself and re-opens it for the viewers", async () => {
    const edit = vi.fn(async () => undefined);
    const d = deps({ id: "chan-1", type: ChannelType.GuildText, permissionOverwrites: { edit } });
    expect(await bindPrivateConsultSession(d as never, {
      sessionId: "sess-1", channelId: "chan-1", provider: "claude", viewerIds: ["111", "900"],
    })).toBe(true);
    expect(d.repo.upsert).toHaveBeenCalledWith(expect.objectContaining({
      session_id: "sess-1", channel_id: "chan-1", channel_kind: "channel", name_body: PRIVATE_CONSULT_NAME_BODY,
    }));
    expect(edit.mock.calls.map((call) => (call as unknown[])[0])).toEqual(["111", "900"]);
    expect(d.webhooks.getForSession).toHaveBeenCalledWith("sess-1");
  });

  it("does not bind when the channel is gone", async () => {
    const d = deps(null);
    expect(await bindPrivateConsultSession(d as never, {
      sessionId: "sess-1", channelId: "chan-1", provider: null, viewerIds: [],
    })).toBe(false);
    expect(d.repo.upsert).not.toHaveBeenCalled();
  });
});

describe("privateConsultPrompt", () => {
  it("states the privacy of the channel and carries the question", () => {
    const prompt = privateConsultPrompt({ topic: "評価の伝え方", skill_level: "初級", role_title: "マネージャー", purpose: "" });
    expect(prompt).toContain("相談者と権限者");
    expect(prompt.endsWith("評価の伝え方")).toBe(true);
  });
});
