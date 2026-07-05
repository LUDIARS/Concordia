import { describe, expect, it } from "vitest";
import { upsertMonitorChannelMessage } from "./monitor-channel.js";
import type { MonitorSnapshot } from "../platform/chat-read-model.js";

function channelHarness() {
  const sent: string[] = [];
  const config = new Map<string, string>();
  const channel = {
    messages: { fetch: async () => { throw new Error("not found"); } },
    send: async (payload: { content: string }) => {
      sent.push(payload.content);
      return { id: "monitor-message" };
    },
  };
  return { sent, config, channel };
}

function snapshot(activeCount: number, channelCostLines: string[]): MonitorSnapshot {
  return {
    generatedAt: 100,
    activeCount,
    orgCostLines: [],
    channelCostLines,
  };
}

describe("upsertMonitorChannelMessage", () => {
  it("renders all channel rows from the supplied snapshot", async () => {
    const h = channelHarness();

    await upsertMonitorChannelMessage(
      h.channel as never,
      snapshot(2, ["- <#head-office-channel>", "- <#subsidiary-channel>"]),
      (key) => h.config.get(key) ?? null,
      (key, value) => { h.config.set(key, value); },
    );

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain("Active session count: 2");
    expect(h.sent[0]).toContain("<#head-office-channel>");
    expect(h.sent[0]).toContain("<#subsidiary-channel>");
  });

  it("renders scoped snapshots without adding omitted channels back", async () => {
    const h = channelHarness();

    await upsertMonitorChannelMessage(
      h.channel as never,
      snapshot(1, ["- <#subsidiary-channel>"]),
      (key) => h.config.get(key) ?? null,
      (key, value) => { h.config.set(key, value); },
    );

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain("Active session count: 1");
    expect(h.sent[0]).toContain("<#subsidiary-channel>");
    expect(h.sent[0]).not.toContain("head-office-channel");
    expect(h.sent[0]).not.toContain("head-off");
  });
});
