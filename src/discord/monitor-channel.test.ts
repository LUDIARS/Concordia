import { describe, expect, it } from "vitest";
import { upsertMonitorChannelMessage } from "./monitor-channel.js";
import type { SessionRow } from "../shared/types.js";

function session(id: string): SessionRow {
  return {
    id,
    provider: "claude-code",
    repo_path: `E:/Document/Ars/${id}`,
    repo_origin: null,
    branch: "main",
    host: "test-host",
    started_at: 1,
    ended_at: null,
    status: "active",
    last_seen_at: 1,
    current_task: null,
    transcript_path: null,
    metadata: null,
    ws_clients: 0,
  };
}

describe("upsertMonitorChannelMessage", () => {
  it("keeps all active channel rows when no monitor scope filter is provided", async () => {
    const sent: string[] = [];
    const config = new Map<string, string>();
    const channel = {
      messages: { fetch: async () => { throw new Error("not found"); } },
      send: async (payload: { content: string }) => {
        sent.push(payload.content);
        return { id: "monitor-message" };
      },
    };
    const sessionsRepo = {
      listSessions: () => [session("head-office-session"), session("subsidiary-session")],
    };
    const sessionChannelsRepo = {
      findBySessionId: (sessionId: string) => ({
        channel_id: sessionId === "subsidiary-session" ? "subsidiary-channel" : "head-office-channel",
      }),
    };

    await upsertMonitorChannelMessage(
      channel as never,
      sessionsRepo as never,
      sessionChannelsRepo as never,
      (key) => config.get(key) ?? null,
      (key, value) => { config.set(key, value); },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Active session count: 2");
    expect(sent[0]).toContain("<#head-office-channel>");
    expect(sent[0]).toContain("<#subsidiary-channel>");
  });

  it("filters active channel rows for scoped subsidiary monitors", async () => {
    const sent: string[] = [];
    const config = new Map<string, string>();
    const channel = {
      messages: { fetch: async () => { throw new Error("not found"); } },
      send: async (payload: { content: string }) => {
        sent.push(payload.content);
        return { id: "monitor-message" };
      },
    };
    const sessionsRepo = {
      listSessions: () => [session("head-office-session"), session("subsidiary-session")],
    };
    const sessionChannelsRepo = {
      findBySessionId: (sessionId: string) => ({
        channel_id: sessionId === "subsidiary-session" ? "subsidiary-channel" : "head-office-channel",
      }),
    };

    await upsertMonitorChannelMessage(
      channel as never,
      sessionsRepo as never,
      sessionChannelsRepo as never,
      (key) => config.get(key) ?? null,
      (key, value) => { config.set(key, value); },
      { sessionFilter: (row) => row.id === "subsidiary-session" },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Active session count: 1");
    expect(sent[0]).toContain("<#subsidiary-channel>");
    expect(sent[0]).not.toContain("head-office-channel");
    expect(sent[0]).not.toContain("head-off");
  });
});
