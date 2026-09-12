import { describe, expect, it, vi } from "vitest";
import { composeReleaseNotice, handleReleasePublished, type ReleasePublishedEvent } from "./release-published.js";
import type { DeployNotifyTarget } from "./service-deployed.js";

const fixture: ReleasePublishedEvent = {
  repository: "ludiars/concordia", kind: "minor", tag: "v1.2.0", previousTag: "v1.1.0", version: "1.2.0",
  title: "通知を追加", notice: Array.from({ length: 12 }, (_, index) => `notice ${index + 1}`).join("\n"),
  releaseUrl: "https://github.com/ludiars/concordia/releases/tag/v1.2.0", publishedAt: "2026-09-12T00:00:00.000Z",
};

const HQ: DeployNotifyTarget = { kind: "cc-channel", target: "" };
const SUBSIDIARY: DeployNotifyTarget = { kind: "subsidiary-channel", target: "channel-1", subsidiaryId: "sub-1", botTokenEnc: "enc" };

function delivery(overrides: Partial<Record<"ccChannel" | "subsidiaryChannel" | "discord" | "slack", unknown>> = {}) {
  return {
    ccChannel: vi.fn(),
    subsidiaryChannel: vi.fn(),
    discord: vi.fn(),
    slack: vi.fn(),
    ...overrides,
  } as never;
}

describe("release-published notification", () => {
  it("delivers the composed fixture once with no enabled mentions", async () => {
    const bot = delivery();
    const result = await handleReleasePublished({
      event: fixture, ledger: { claim: () => true }, lookup: { targets: () => [HQ] }, delivery: bot,
    });
    expect(result).toEqual({ duplicate: false, unconfigured: false, delivered: [{ target: { kind: "cc-channel", target: "" } }], failed: [] });
    expect((bot as unknown as { ccChannel: ReturnType<typeof vi.fn> }).ccChannel)
      .toHaveBeenCalledWith(expect.stringContaining("【ludiars/concordia v1.2.0 リリース】 通知を追加"));
    expect(composeReleaseNotice(fixture).split("\n")).toHaveLength(12);
  });

  // 本社だけに流していたのを、担当子会社にも配る。 判定は CC-INV-06 を共有する。
  it("delivers to the subsidiary channel alongside HQ", async () => {
    const bot = delivery();
    const result = await handleReleasePublished({
      event: fixture, ledger: { claim: () => true }, lookup: { targets: () => [HQ, SUBSIDIARY] }, delivery: bot,
    });
    expect(result.delivered.map((entry) => entry.target)).toEqual([
      { kind: "cc-channel", target: "" },
      { kind: "subsidiary-channel", target: "channel-1", subsidiaryId: "sub-1" },
    ]);
    expect((bot as unknown as { subsidiaryChannel: ReturnType<typeof vi.fn> }).subsidiaryChannel)
      .toHaveBeenCalledWith("channel-1", "enc", expect.stringContaining("リリース"));
  });

  it("suppresses a duplicate fixture before delivery", async () => {
    const bot = delivery();
    const targets = vi.fn(() => [HQ]);
    await expect(handleReleasePublished({ event: fixture, ledger: { claim: () => false }, lookup: { targets }, delivery: bot }))
      .resolves.toEqual({ duplicate: true, unconfigured: false, delivered: [], failed: [] });
    expect(targets).not.toHaveBeenCalled();
    expect((bot as unknown as { ccChannel: ReturnType<typeof vi.fn> }).ccChannel).not.toHaveBeenCalled();
  });

  it("records an unconfigured destination without attempting delivery", async () => {
    const bot = delivery();
    await expect(handleReleasePublished({ event: fixture, ledger: { claim: () => true }, lookup: { targets: () => [] }, delivery: bot }))
      .resolves.toEqual({ duplicate: false, unconfigured: true, delivered: [], failed: [] });
    expect((bot as unknown as { ccChannel: ReturnType<typeof vi.fn> }).ccChannel).not.toHaveBeenCalled();
  });

  it("preserves a Bot delivery failure without retrying the claimed release", async () => {
    const bot = delivery({ ccChannel: async () => { throw new Error("Bot rejected request"); } });
    await expect(handleReleasePublished({ event: fixture, ledger: { claim: () => true }, lookup: { targets: () => [HQ] }, delivery: bot }))
      .resolves.toEqual({
        duplicate: false,
        unconfigured: false,
        delivered: [],
        failed: [{ target: { kind: "cc-channel", target: "" }, error: "Bot rejected request" }],
      });
  });

  // 1 つの宛先が落ちても残りは届く。 子会社だけ落ちた状態を「配送成功」に埋めない。
  it("keeps HQ delivery when the subsidiary channel fails", async () => {
    const bot = delivery({ subsidiaryChannel: async () => { throw new Error("subsidiary rejected"); } });
    const result = await handleReleasePublished({
      event: fixture, ledger: { claim: () => true }, lookup: { targets: () => [HQ, SUBSIDIARY] }, delivery: bot,
    });
    expect(result.delivered.map((entry) => entry.target.kind)).toEqual(["cc-channel"]);
    expect(result.failed.map((entry) => entry.target.kind)).toEqual(["subsidiary-channel"]);
    expect(result.unconfigured).toBe(false);
  });
});
