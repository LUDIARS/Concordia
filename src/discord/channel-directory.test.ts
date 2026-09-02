import { describe, expect, it, vi } from "vitest";
import type { DiscordChannelDirectoryDeps } from "./channel-directory.js";
import { makeDiscordChannelDirectory } from "./channel-directory.js";

describe("makeDiscordChannelDirectory", () => {
  it("exposes the configured Genius channel to session clients", () => {
    const deps = {
      config: {
        all: vi.fn(() => ({ genius_channel_id: "genius-1" })),
      },
      pendingQuestions: {},
      sessionChannels: {},
    } as unknown as DiscordChannelDirectoryDeps;

    expect(makeDiscordChannelDirectory(deps).listMetaChannels()).toMatchObject({
      genius: "genius-1",
    });
  });
});
