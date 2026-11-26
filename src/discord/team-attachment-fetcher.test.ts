import { describe, expect, it, vi } from "vitest";
import { createTeamAttachmentFetcher } from "./team-attachment-fetcher.js";

const image = { id: "a1", name: "plan.png", contentType: "image/png", size: 12, url: "https://cdn.discordapp.com/a/plan.png" };
const pdf = { id: "a2", name: "spec.pdf", contentType: "application/pdf", size: 34, url: "https://cdn.discordapp.com/a/spec.pdf" };
const input = { teamId: "team_a", channelId: "11", messageId: "22" };

describe("createTeamAttachmentFetcher", () => {
  it("refetches the post and stores images and files in the team's inbox", async () => {
    const readAttachments = vi.fn(async () => [image, pdf]);
    const storeImages = vi.fn(async () => ["T:/inbox/team_a-22-1.png"]);
    const storeFiles = vi.fn(async () => [{ path: "T:/inbox/team_a-22-1.pdf", name: "spec.pdf", size: 34, text: null, textTruncated: false }]);
    const fetcher = createTeamAttachmentFetcher({ reader: { readAttachments }, inboxRoot: "T:/root", storeImages, storeFiles });

    await expect(fetcher.fetch(input)).resolves.toEqual({ ok: true, attachments: [
      { kind: "image", name: "plan.png", size: 12, path: "T:/inbox/team_a-22-1.png", url: image.url },
      { kind: "file", name: "spec.pdf", size: 34, path: "T:/inbox/team_a-22-1.pdf", url: pdf.url },
    ] });
    expect(readAttachments).toHaveBeenCalledWith("11", "22");
    const call = (storeImages.mock.calls[0] as unknown as [{ inboxRoot: string; messageId: string; sessionId: string }])[0];
    expect(call.messageId).toBe("22");
    expect(call.sessionId).toBe("team_a");
    expect(call.inboxRoot.replace(/\\/g, "/")).toBe("T:/root/concordia-team-discussion-attachments/team_a");
  });

  it("reports a Discord failure and a storage refusal separately", async () => {
    const down = createTeamAttachmentFetcher({
      reader: { readAttachments: async () => { throw new Error("down"); } }, log: { warn: vi.fn() },
    });
    await expect(down.fetch(input)).resolves.toEqual({ ok: false, error: "discord_api_error" });

    const refused = createTeamAttachmentFetcher({
      reader: { readAttachments: async () => [image] },
      storeImages: async () => { throw new Error("internal"); },
    });
    await expect(refused.fetch(input)).resolves.toEqual({
      ok: false, error: "store_failed", detail: "画像の取得または保存中に内部エラーが発生しました",
    });
  });
});
