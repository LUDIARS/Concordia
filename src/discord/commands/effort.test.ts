import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscordCommandDeps } from "../command-port.js";
import effortCommand from "./effort.js";

function makeInteraction(level: string, reason: string | null) {
  return {
    channelId: "chan-1",
    user: { id: "user-1", username: "neco-user", globalName: "neco" },
    options: {
      getString: (name: string) => (name === "level" ? level : name === "reason" ? reason : null),
    },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  };
}

function makeDeps(): DiscordCommandDeps {
  return {
    concordiaUrl: "http://127.0.0.1:11111",
    sessionsRepo: {} as DiscordCommandDeps["sessionsRepo"],
    sessionChannelsRepo: {
      findByChannelId: vi.fn(() => ({ session_id: "s-1", channel_id: "chan-1" })),
    } as unknown as DiscordCommandDeps["sessionChannelsRepo"],
    pendingQuestionsRepo: {} as DiscordCommandDeps["pendingQuestionsRepo"],
    guild: {} as DiscordCommandDeps["guild"],
    layout: {} as DiscordCommandDeps["layout"],
    log: { info: vi.fn(), warn: vi.fn() },
  };
}

describe("/co-effort", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks Concordia to change the session effort as a human decision", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, changed: true, effort: "xhigh", previous: "medium" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const interaction = makeInteraction("xhigh", "設計判断");

    await effortCommand.execute(interaction as never, makeDeps());

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:11111/v1/sessions/s-1/effort");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      effort: "xhigh", actor: "human", reason: "設計判断", requested_by: "neco",
    });
    expect(interaction.editReply).toHaveBeenCalledWith({ content: "🎚️ effort を medium → xhigh に変更しました。" });
  });

  it("uses a default reason and reports failures", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "runtime_apply_failed" }), { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    const interaction = makeInteraction("high", null);

    await effortCommand.execute(interaction as never, makeDeps());

    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown[])[1] && ((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body)).reason)
      .toBe("Discord の /co-effort による変更");
    expect(interaction.editReply).toHaveBeenCalledWith({ content: expect.stringContaining("effort を変更できませんでした") });
  });
});
