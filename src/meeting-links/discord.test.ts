import { afterEach, it, expect, vi } from "vitest";
import type { Interaction } from "discord.js";
import { handleMeetingLinkInteraction } from "./discord.js";
import type { MeetingLinkStore } from "./store.js";
afterEach(() => vi.unstubAllEnvs());
it("acknowledges privately and rejects a forged announcement before minting", async () => {
  vi.stubEnv("CONCORDIA_MEETING_LINK_ENABLED", "true");
  vi.stubEnv("CONCORDIA_MEETING_LINK_GUILD_ID", "1136199339417534606");
  vi.stubEnv("CONCORDIA_MEETING_LINK_PUBLIC_URL", "https://example.test");
  const deferReply = vi.fn(); const editReply = vi.fn(); const issue = vi.fn();
  const interaction = { isButton: () => true, deferReply, editReply,
    customId: "aedilis:respond:7395f8d0-a6b6-4c44-808b-24e3073dc777",
    guildId: "1136199339417534606", guild: {}, user: { bot: false },
    client: { user: { id: "our-bot" } }, applicationId: "our-app",
    message: { author: { id: "other" }, applicationId: null, embeds: [] },
  } as unknown as Interaction;
  await handleMeetingLinkInteraction(interaction, { issue } as unknown as MeetingLinkStore);
  expect(deferReply).toHaveBeenCalledWith({ flags: 64 });
  expect(issue).not.toHaveBeenCalled();
  expect(editReply).toHaveBeenCalledWith("正式な予定案内から回答ボタンを押してください。");
});
