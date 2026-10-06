import { afterEach, describe, expect, it, vi } from "vitest";
import type { TextChannel } from "discord.js";
import { startServiceStatusDiscord, statusChannelPort } from "./service-status.js";
import type { StatusSnapshot } from "../service-status/policy.js";
afterEach(() => { vi.useRealTimers(); });
describe("status Discord adapter", () => {
  it("disables mentions and passes a nonce for duplicate-send reconciliation", async () => {
    const send = vi.fn().mockResolvedValue({ id: "message" });
    const port = statusChannelPort({ send } as unknown as TextChannel);
    expect(await port.send("status", "nonce")).toBe("message");
    expect(send).toHaveBeenCalledWith({ content: "status", nonce: "nonce", enforceNonce: true, allowedMentions: { parse: [] } });
  });
  it("stopping during the Ex read cancels future timer work and prevents publication", async () => {
    vi.useFakeTimers(); let resolve!: (snapshot: StatusSnapshot) => void;
    const send = vi.fn(); const read = vi.fn(() => new Promise<StatusSnapshot>((done) => { resolve = done; }));
    const config = { get: () => null, set: vi.fn() };
    const runtime = startServiceStatusDiscord({ db: {} as never, subsidiaryId: null, config: config as never, channel: { send } as unknown as TextChannel, warn: vi.fn(), read });
    const stopped = runtime.stop(); resolve({ generatedAt: Date.now(), staleAfterMs: 60_000, sites: [], services: [] });
    await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(60_000);
    await stopped;
    expect(read).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
  });
});
