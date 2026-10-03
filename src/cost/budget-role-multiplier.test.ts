import { describe, expect, it, vi } from "vitest";
import { DiscordRoleMultiplierResolver, lowestRoleMultiplier } from "./budget-role-multiplier.js";

describe("lowestRoleMultiplier", () => {
  const multipliers = new Map([["10001", 0.5], ["10002", 0.8], ["10003", 2]]);

  it("倍率が設定されたロールのいちばん低い倍率を使う", () => {
    expect(lowestRoleMultiplier(["10002", "10001", "10003"], multipliers)).toBe(0.5);
    expect(lowestRoleMultiplier(["10003"], multipliers)).toBe(2);
  });

  it("倍率の無いロールだけ・ロールなしは 1", () => {
    expect(lowestRoleMultiplier(["99999"], multipliers)).toBe(1);
    expect(lowestRoleMultiplier([], multipliers)).toBe(1);
  });

  it("範囲外の倍率は無視する", () => {
    expect(lowestRoleMultiplier(["1", "2"], new Map([["1", 0], ["2", 11]]))).toBe(1);
  });
});

describe("DiscordRoleMultiplierResolver", () => {
  it("人のロールを数分キャッシュし、 期限が切れたら引き直す", async () => {
    let now = 0;
    const memberRoleIds = vi.fn(async () => ["10001"]);
    const resolver = new DiscordRoleMultiplierResolver({
      memberRoleIds, multipliers: () => new Map([["10001", 0.5]]), now: () => now, cacheTtlMs: 1000,
    });
    expect(await resolver.multiplierFor("500001")).toBe(0.5);
    now = 999;
    expect(await resolver.multiplierFor("500001")).toBe(0.5);
    expect(memberRoleIds).toHaveBeenCalledTimes(1);
    now = 1000;
    await resolver.multiplierFor("500001");
    expect(memberRoleIds).toHaveBeenCalledTimes(2);
  });

  it("ロールが引けない・失敗したら 1 に倒し、 失敗はキャッシュしない", async () => {
    const memberRoleIds = vi.fn()
      .mockRejectedValueOnce(new Error("bot down"))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(["10001"]);
    const resolver = new DiscordRoleMultiplierResolver({ memberRoleIds, multipliers: () => new Map([["10001", 0.5]]) });
    expect(await resolver.multiplierFor("500001")).toBe(1);
    expect(await resolver.multiplierFor("500001")).toBe(1);
    expect(await resolver.multiplierFor("500001")).toBe(0.5);
  });

  it("倍率が 1 件も無い・利用者不明なら Discord に問い合わせない", async () => {
    const memberRoleIds = vi.fn(async () => ["10001"]);
    const resolver = new DiscordRoleMultiplierResolver({ memberRoleIds, multipliers: () => new Map() });
    expect(await resolver.multiplierFor("500001")).toBe(1);
    expect(await new DiscordRoleMultiplierResolver({ memberRoleIds, multipliers: () => new Map([["10001", 0.5]]) })
      .multiplierFor(null)).toBe(1);
    expect(memberRoleIds).not.toHaveBeenCalled();
  });

  it("invalidate で次の照会から引き直す", async () => {
    const memberRoleIds = vi.fn(async () => ["10001"]);
    const resolver = new DiscordRoleMultiplierResolver({ memberRoleIds, multipliers: () => new Map([["10001", 0.5]]) });
    await resolver.multiplierFor("500001");
    resolver.invalidate();
    await resolver.multiplierFor("500001");
    expect(memberRoleIds).toHaveBeenCalledTimes(2);
  });
});
