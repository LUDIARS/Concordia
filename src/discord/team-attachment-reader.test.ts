import { describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("discord.js")>();
  class FakeRest { setToken() { return this; } get(route: string) { return get(route); } }
  return { ...actual, REST: FakeRest };
});

const { createTeamAttachmentReader, TeamAttachmentMessageMismatchError } = await import("./team-attachment-reader.js");

describe("createTeamAttachmentReader", () => {
  it("returns fresh attachment URLs for exactly the requested post", async () => {
    get.mockResolvedValueOnce({
      id: "22", channel_id: "11",
      attachments: [{ id: "a1", filename: "plan.png", content_type: "image/png", size: 12, url: "https://cdn.discordapp.com/a/plan.png" }],
    });
    const reader = createTeamAttachmentReader({ resolveToken: () => "token" });
    await expect(reader.readAttachments("11", "22")).resolves.toEqual([
      { id: "a1", name: "plan.png", contentType: "image/png", size: 12, url: "https://cdn.discordapp.com/a/plan.png" },
    ]);
    expect(get).toHaveBeenCalledWith("/channels/11/messages/22");
  });

  it("rejects a different post and a missing token", async () => {
    get.mockResolvedValueOnce({ id: "99", channel_id: "11", attachments: [] });
    const reader = createTeamAttachmentReader({ resolveToken: () => "token" });
    await expect(reader.readAttachments("11", "22")).rejects.toBeInstanceOf(TeamAttachmentMessageMismatchError);
    await expect(createTeamAttachmentReader({ resolveToken: () => null }).readAttachments("11", "22"))
      .rejects.toThrow("not configured");
  });
});
