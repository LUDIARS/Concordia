import { describe, expect, it, vi } from "vitest";
import { createDailyGoalSurface } from "./surface.js";
import type { DailyGoalRunService } from "./service.js";

describe("createDailyGoalSurface", () => {
  it("resolves the live staff role for every confirm and stop", () => {
    const confirmGoal = vi.fn(() => ({ ok: false, kind: "missing", missing: [] }));
    const stopByHuman = vi.fn(() => ({ id: "g" }));
    const roles = ["staff", "manager"] as const;
    let call = 0;
    const service = { confirmGoal, stopByHuman, deps: { repo: {}, config: () => ({ launchTime: "07:30" }) } } as unknown as DailyGoalRunService;
    const surface = createDailyGoalSurface(service, { roleOf: () => roles[call++] ?? null, isEnabled: () => true, now: () => 7 });
    const actor = { userId: "u", guildId: "g", channelId: "c", isBot: false, isWebhook: false };
    surface.confirm({ draft: {}, actor, receiptId: "i" });
    surface.stop("g", actor);
    expect(confirmGoal).toHaveBeenCalledWith({ draft: {}, actor: { platform: "discord", ...actor, role: "staff" }, receiptId: "i", now: 7 });
    expect(stopByHuman).toHaveBeenCalledWith("g", { platform: "discord", ...actor, role: "manager" }, 7);
  });

  it("computes the launch time from the configured value", () => {
    const service = { deps: { repo: {}, config: () => ({ launchTime: "08:00" }) } } as unknown as DailyGoalRunService;
    const surface = createDailyGoalSurface(service, { roleOf: () => null, isEnabled: () => false });
    const confirmedAt = new Date(2026, 9, 10, 6, 0).getTime();
    expect(surface.launchAtFor({ confirmedAt, date: "2026-10-10" } as never)).toBe(new Date(2026, 9, 10, 8, 0).getTime());
    expect(surface.isEnabled()).toBe(false);
  });
});
