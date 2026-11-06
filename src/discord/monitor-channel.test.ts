import { describe, expect, it, vi } from "vitest";
import { upsertMonitorChannelMessage } from "./monitor-channel.js";
import type { MonitorSnapshot } from "../platform/chat-read-model.js";

function channelHarness() {
  const sent: string[] = [];
  const config = new Map<string, string>();
  const channel = {
    id: "channel", client: { user: { id: "bot" } },
    messages: { fetch: vi.fn(async (_arg: unknown): Promise<unknown> => new Map()) },
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

  it("edits the saved message and does not recreate on lookup failure", async () => {
    const h = channelHarness(); const edit = vi.fn();
    h.config.set("monitor_status_message_id", "existing");
    h.channel.messages.fetch.mockResolvedValueOnce({ author: { id: "bot" }, edit });
    const update = () => upsertMonitorChannelMessage(h.channel as never, snapshot(1, []),
      k => h.config.get(k) ?? null, (k, v) => { h.config.set(k, v); });
    await update(); expect(edit).toHaveBeenCalledOnce();
    h.channel.messages.fetch.mockRejectedValueOnce(new Error("timeout"));
    await expect(update()).rejects.toThrow("timeout"); expect(h.sent).toHaveLength(0);
  });

  it("reconciles a bot-authored marker after send response loss and restart", async () => {
    const h = channelHarness(); const edit = vi.fn();
    h.config.set("monitor_status_delivery_state", "sending");
    h.channel.messages.fetch.mockResolvedValueOnce(new Map([["existing", {
      id: "existing", author: { id: "bot" }, content: "-# cc:session-monitor:v1", edit,
    }]]));
    await upsertMonitorChannelMessage(h.channel as never, snapshot(1, []), k => h.config.get(k) ?? null,
      (k, v) => { h.config.set(k, v); });
    expect(h.config.get("monitor_status_message_id")).toBe("existing");
    expect(edit).toHaveBeenCalledOnce(); expect(h.sent).toHaveLength(0);
  });

  it("does not resend an unknown creation when reconciliation finds nothing", async () => {
    const h = channelHarness(); h.config.set("monitor_status_delivery_state", "sending");
    await expect(upsertMonitorChannelMessage(h.channel as never, snapshot(1, []), k => h.config.get(k) ?? null,
      (k, v) => { h.config.set(k, v); })).rejects.toThrow("outcome unknown");
    expect(h.sent).toHaveLength(0);
  });

  it("coalesces concurrent refreshes", async () => {
    const h = channelHarness();
    const update = () => upsertMonitorChannelMessage(h.channel as never, snapshot(1, []),
      k => h.config.get(k) ?? null, (k, v) => { h.config.set(k, v); });
    await Promise.all([update(), update()]); expect(h.sent).toHaveLength(1);
  });

  it("records sending before I/O and fences a lost send response", async () => {
    const h = channelHarness();
    const send = vi.fn(async () => {
      expect(h.config.get("monitor_status_delivery_state")).toBe("sending");
      throw new Error("response lost");
    });
    const channel = { ...h.channel, send };
    const update = () => upsertMonitorChannelMessage(channel as never, snapshot(1, []),
      k => h.config.get(k) ?? null, (k, v) => { h.config.set(k, v); });
    await expect(update()).rejects.toThrow("response lost");
    await expect(update()).rejects.toThrow("outcome unknown");
    expect(send).toHaveBeenCalledOnce();
  });
});
