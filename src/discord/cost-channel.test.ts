import { describe, expect, it, vi } from "vitest";
import type { TextChannel } from "discord.js";
import type { OAuthUsage } from "../auth/anthropic-oauth-usage.js";
import { notifyCostActivity, upsertCostChannelMessage } from "./cost-channel.js";
import type { ChatReadModel } from "../platform/chat-read-model.js";

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
  const send = vi.fn(async (): Promise<void> => undefined);
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
  it("使用量の取得が復旧しても上限接近以外は通知しない", async () => {
    const h = harness();
    // 旧実装が「取得復旧」通知を出す条件そのもの。 廃止後もこの残存値で復活しないことを
    // 固定する (キーは他から読まれないので、消すと回帰を検出できなくなる)。
    h.configSet("cost_activity:available", "0");
    const input = {
      activityChannel: h.channel,
      configGet: h.configGet,
      configSet: h.configSet,
      codexRate: { used5h: null, reset5hAt: null },
    };
    await notifyCostActivity({ ...input, claudeUsage: null });
    await notifyCostActivity({ ...input, claudeUsage: usage() });
    expect(h.send).not.toHaveBeenCalled();
    await notifyCostActivity({
      ...input,
      claudeUsage: usage({ fiveHour: { utilization: 80, resetsAtSec: null } }),
    });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(expect.stringContaining("Claude 5H cost usage is 80.0%"));
  });

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

  // 2026-09-03 実測: 上流の resets_at は同じ窓でも 05:09:59 / 05:10:00 を往復する。
  // 完全一致でバケット判定していた頃はこれで 10 分ごとに鳴り続けていた。
  it("リセット時刻が 1 秒揺れても同じ窓では 1 回しか通知しない", async () => {
    const h = harness();
    const resetsAtSec = Math.floor(Date.now() / 1000) + 3600;
    const call = (reset: number) => notifyCostActivity({
      activityChannel: h.channel,
      configGet: h.configGet,
      configSet: h.configSet,
      codexRate: { used5h: 92, reset5hAt: reset },
      claudeUsage: usage({
        fiveHour: { utilization: 90, resetsAtSec: reset },
        weeklyScoped: [{ label: "Fable", utilization: 90, resetsAtSec: reset, severity: "critical" }],
      }),
    });

    await call(resetsAtSec);
    await call(resetsAtSec + 1);
    await call(resetsAtSec);

    const texts = h.send.mock.calls.map((c) => sentText((c as unknown[])[0]));
    expect(texts.filter((t) => t.includes("Codex 5H"))).toHaveLength(1);
    expect(texts.filter((t) => t.includes("Claude 5H"))).toHaveLength(1);
    expect(texts.filter((t) => t.includes("Fable"))).toHaveLength(1);
  });

  it("リセット時刻を過ぎて次の窓に入ったら改めて通知する", async () => {
    const h = harness();
    const nowSec = Math.floor(Date.now() / 1000);
    const call = (reset: number) => notifyCostActivity({
      activityChannel: h.channel,
      configGet: h.configGet,
      configSet: h.configSet,
      codexRate: { used5h: null, reset5hAt: null },
      claudeUsage: usage({ fiveHour: { utilization: 90, resetsAtSec: reset } }),
    });

    await call(nowSec - 60);
    await call(nowSec + 5 * 3600);

    expect(h.send.mock.calls.map((c) => sentText((c as unknown[])[0]))
      .filter((t) => t.includes("Claude 5H"))).toHaveLength(2);
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

  it("5H 通知は送信成功後にだけ記録し、失敗後の更新で再試行する", async () => {
    const h = harness();
    h.send.mockRejectedValueOnce(new Error("temporary Discord failure"));
    const input = {
      activityChannel: h.channel,
      configGet: h.configGet,
      configSet: h.configSet,
      codexRate: { used5h: 90, reset5hAt: 1_700_500_000 },
      claudeUsage: null,
    };

    await expect(notifyCostActivity(input)).rejects.toThrow("temporary Discord failure");
    await expect(notifyCostActivity(input)).resolves.toBeUndefined();
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it("同じ 5H 警告の並行更新を 1 回の送信に畳む", async () => {
    const h = harness();
    let release: () => void = () => {};
    h.send.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const input = {
      activityChannel: h.channel,
      configGet: h.configGet,
      configSet: h.configSet,
      codexRate: { used5h: 90, reset5hAt: 1_700_500_000 },
      claudeUsage: null,
    };

    const first = notifyCostActivity(input);
    const second = notifyCostActivity(input);
    await Promise.resolve();
    expect(h.send).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});

describe("upsertCostChannelMessage", () => {
  function readModel(): ChatReadModel {
    return {
      getCostSnapshot: async () => ({
        markdown: "cost body",
        codexRate: { used5h: 90, reset5hAt: 1_700_500_000 },
        claudeUsage: null,
      }),
    } as unknown as ChatReadModel;
  }

  it("activity 通知失敗で更新済み cost message を新規作成しない", async () => {
    const edit = vi.fn(async () => undefined);
    const costSend = vi.fn(async () => ({ id: "new" }));
    const channel = {
      messages: { fetch: vi.fn(async () => ({ edit })) },
      send: costSend,
    } as unknown as TextChannel;
    const activity = {
      send: vi.fn(async () => { throw new Error("activity unavailable"); }),
    } as unknown as TextChannel;

    await expect(upsertCostChannelMessage(
      channel,
      readModel(),
      (key) => key === "cost_status_message_id" ? "existing" : null,
      () => {},
      activity,
    )).rejects.toThrow("activity unavailable");
    expect(edit).toHaveBeenCalledTimes(1);
    expect(costSend).not.toHaveBeenCalled();
  });

  it("一時的な fetch 失敗では duplicate cost message を作らない", async () => {
    const costSend = vi.fn(async () => ({ id: "new" }));
    const channel = {
      messages: { fetch: vi.fn(async () => { throw new Error("gateway timeout"); }) },
      send: costSend,
    } as unknown as TextChannel;

    await expect(upsertCostChannelMessage(
      channel,
      readModel(),
      () => "existing",
      () => {},
    )).rejects.toThrow("gateway timeout");
    expect(costSend).not.toHaveBeenCalled();
  });

  it("Discord が既存 message 不在を返した場合だけ新規作成する", async () => {
    const costSend = vi.fn(async () => ({ id: "replacement" }));
    const configSet = vi.fn();
    const channel = {
      messages: { fetch: vi.fn(async () => { throw { code: 10_008 }; }) },
      send: costSend,
    } as unknown as TextChannel;

    await upsertCostChannelMessage(channel, readModel(), () => "missing", configSet);
    expect(costSend).toHaveBeenCalledTimes(1);
    expect(configSet).toHaveBeenCalledWith("cost_status_message_id", "replacement");
  });
});
