import { describe, expect, it, vi } from "vitest";
import { createDailyGoalSurface } from "./surface.js";
import type { DailyGoalRunService } from "./service.js";

describe("createDailyGoalSurface", () => {
  it("resolves the live staff role for every post, stop and resend", async () => {
    const intakePost = vi.fn(async () => ({ kind: "ignored" }));
    const stopByHuman = vi.fn(() => ({ id: "g" }));
    const resendSummary = vi.fn(async () => ({ businessDate: "2026-10-10" }));
    const roles = ["staff", "manager", "executive"] as const;
    let call = 0;
    const service = { intake: { intakePost }, stopByHuman, resendSummary, deps: { repo: {} } } as unknown as DailyGoalRunService;
    const surface = createDailyGoalSurface(service, { roleOf: () => roles[call++] ?? null, isEnabled: () => true, now: () => 7 });
    const actor = { userId: "u", guildId: "g", channelId: "c", isBot: false, isWebhook: false };
    await surface.intake.post({ text: "目標", messageId: "m1", actor });
    surface.stop("g", actor);
    await surface.resendSummary("2026-10-10", actor);
    expect(intakePost).toHaveBeenCalledWith({ text: "目標", messageId: "m1", actor: { platform: "discord", ...actor, role: "staff" }, now: 7 });
    expect(stopByHuman).toHaveBeenCalledWith("g", { platform: "discord", ...actor, role: "manager" }, 7);
    expect(resendSummary).toHaveBeenCalledWith("2026-10-10", { platform: "discord", ...actor, role: "executive" }, 7);
  });

  it("exposes the posting guide as the channel topic and the enabled flag", () => {
    const surface = createDailyGoalSurface({ deps: { repo: {} } } as unknown as DailyGoalRunService, { roleOf: () => null, isEnabled: () => false });
    expect(surface.channelTopic()).toContain("目標なし");
    expect(surface.isEnabled()).toBe(false);
  });
});
