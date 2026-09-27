import { describe, it, expect, vi } from "vitest";
import type { ExcubitorClient } from "../excubitor/client.js";
import { createBacklogAdmission } from "./actio-chat-admission.js";
describe("Actio command admission", () => {
  const catalog = { findService: vi.fn(async () => ({ state: "running", port: 1, catalog_snapshot: { port: 17880 } })) } as unknown as Pick<ExcubitorClient, "findService">;
  it("uses the declared catalog endpoint and explicit shared secret", async () => {
    const request = vi.fn(async () => Response.json({ allowed: true }));
    expect(await createBacklogAdmission(catalog, () => "key", request as typeof fetch)("guild", "channel")).toBe(true);
    expect(request).toHaveBeenCalledWith("http://127.0.0.1:17880/api/chat/commands/access", expect.objectContaining({ redirect: "error", body: JSON.stringify({ guildId: "guild", channelId: "channel" }) }));
  });
  it("fails closed on missing credentials, non-boolean admission, and HTTP errors", async () => {
    const request = vi.fn(async () => Response.json({ allowed: "true" }));
    await expect(createBacklogAdmission(catalog, () => "", request as typeof fetch)("g", "c")).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
    expect(await createBacklogAdmission(catalog, () => "key", request as typeof fetch)("g", "c")).toBe(false);
    await expect(createBacklogAdmission(catalog, () => "key", (async () => new Response("", { status: 503 })) as typeof fetch)("g", "c")).rejects.toThrow("unavailable");
  });
});
