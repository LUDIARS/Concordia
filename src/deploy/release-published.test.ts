import { describe, expect, it, vi } from "vitest";
import { composeReleaseNotice, handleReleasePublished, type ReleasePublishedEvent } from "./release-published.js";

const fixture: ReleasePublishedEvent = {
  repository: "ludiars/concordia", kind: "minor", tag: "v1.2.0", previousTag: "v1.1.0", version: "1.2.0",
  title: "通知を追加", notice: Array.from({ length: 12 }, (_, index) => `notice ${index + 1}`).join("\n"),
  releaseUrl: "https://github.com/ludiars/concordia/releases/tag/v1.2.0", publishedAt: "2026-09-12T00:00:00.000Z",
};

describe("release-published notification", () => {
  it("delivers the composed fixture once with no enabled mentions", async () => {
    const ccChannel = vi.fn();
    const result = await handleReleasePublished({ event: fixture, ledger: { claim: () => true }, channelConfigured: true, delivery: { ccChannel } });
    expect(result).toEqual({ duplicate: false, unconfigured: false, delivered: true, failed: null });
    expect(ccChannel).toHaveBeenCalledWith(expect.stringContaining("【ludiars/concordia v1.2.0 リリース】 通知を追加"));
    expect(composeReleaseNotice(fixture).split("\n")).toHaveLength(12);
  });

  it("suppresses a duplicate fixture before delivery", async () => {
    const ccChannel = vi.fn();
    await expect(handleReleasePublished({ event: fixture, ledger: { claim: () => false }, channelConfigured: true, delivery: { ccChannel } }))
      .resolves.toEqual({ duplicate: true, unconfigured: false, delivered: false, failed: null });
    expect(ccChannel).not.toHaveBeenCalled();
  });

  it("records an unconfigured channel without attempting delivery", async () => {
    const ccChannel = vi.fn();
    await expect(handleReleasePublished({ event: fixture, ledger: { claim: () => true }, channelConfigured: false, delivery: { ccChannel } }))
      .resolves.toEqual({ duplicate: false, unconfigured: true, delivered: false, failed: null });
    expect(ccChannel).not.toHaveBeenCalled();
  });

  it("preserves a Bot delivery failure without retrying the claimed release", async () => {
    await expect(handleReleasePublished({ event: fixture, ledger: { claim: () => true }, channelConfigured: true, delivery: { ccChannel: async () => { throw new Error("Bot rejected request"); } } }))
      .resolves.toEqual({ duplicate: false, unconfigured: false, delivered: false, failed: "Bot rejected request" });
  });
});
