import { describe, expect, it, vi } from "vitest";
import type { TextChannel } from "discord.js";
import type { OAuthUsage } from "../auth/anthropic-oauth-usage.js";
import { notifyCostActivity } from "./cost-channel.js";

// 2026-09-03: Fable などモデル別の週間枠は全体枠より先に尽きるので、活動チャンネルにも出す。

function usage(patch: Partial<OAuthUsage> = {}): OAuthUsage {
  return {
    plan: null,
    fiveHour: { utilization: 10, resetsAtSec: 1_700_000_000 },
    sevenDay: { utilization: 57, resetsAtSec: 1_700_500_000 },
    sevenDaySonnet: null,
    sevenDayOpus: null,
    sevenDayFable: null,
    weeklyScoped: [],
    extraCredit: { isEnabled: false, monthlyLimit: null, usedCredits: null, utilization: null, currency: null },
    fetchedAt: 0,
    ...patch,
  };
}

function harness() {
  const store = new Map<string, string>();
  const send = vi.fn(async () => undefined);
  return {
    channel: { send } as unknown as TextChannel,
    send,
    configGet: (k: string) => store.get(k) ?? null,
    configSet: (k: string, v: string) => { store.set(k, v); },
  };
}

function sentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "content" in value) {
    return String((value as { content: unknown }).content);
  }
  return String(value);
}

describe("notifyCostActivity: モデル別週間枠", () => {
  it("80% 以上のモデル別週間枠はリセット期間につき 1 回だけ通知する", async () => {
    const h = harness();
    const claudeUsage = usage({
      weeklyScoped: [{ label: "Fable", utilization: 90, resetsAtSec: 1_700_500_000, severity: "critical" }],
    });
    const input = {
      activityChannel: h.channel,
      configGet: h.configGet,
      configSet: h.configSet,
      codexRate: { used5h: null, reset5hAt: null },
      claudeUsage,
    };
    await notifyCostActivity(input);
    await notifyCostActivity(input);
    const scopedMessages = h.send.mock.calls
      .map((call) => sentText((call as unknown[])[0]))
      .filter((text) => text.includes("Fable"));
    expect(scopedMessages).toEqual([
      "Claude Fable weekly cost usage is 90.0% [critical] (resets <t:1700500000:f> (<t:1700500000:R>))",
    ]);
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ allowedMentions: { parse: [] } }));
  });

  it("80% 未満は通知しない", async () => {
    const h = harness();
    await notifyCostActivity({
      activityChannel: h.channel,
      configGet: h.configGet,
      configSet: h.configSet,
      codexRate: { used5h: null, reset5hAt: null },
      claudeUsage: usage({ weeklyScoped: [{ label: "Fable", utilization: 40, resetsAtSec: null, severity: "normal" }] }),
    });
    expect(h.send.mock.calls.some((call) => sentText((call as unknown[])[0]).includes("Fable"))).toBe(false);
  });

  it("通知送信が失敗した場合は同じリセット期間内でも再試行する", async () => {
    const h = harness();
    h.send.mockRejectedValueOnce(new Error("temporary Discord failure"));
    const input = {
      activityChannel: h.channel,
      configGet: h.configGet,
      configSet: h.configSet,
      codexRate: { used5h: null, reset5hAt: null },
      claudeUsage: usage({
        weeklyScoped: [{ label: "Fable", utilization: 90, resetsAtSec: 1_700_500_000, severity: "critical" }],
      }),
    };

    await expect(notifyCostActivity(input)).rejects.toThrow("temporary Discord failure");
    await expect(notifyCostActivity(input)).resolves.toBeUndefined();
    expect(h.send).toHaveBeenCalledTimes(2);
  });
});
