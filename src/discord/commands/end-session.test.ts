import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscordCommandDeps } from "../command-port.js";
import endSessionCommand from "./end-session.js";

function makeInteraction() {
  return {
    channelId: "chan-1",
    channel: { isThread: () => false },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  };
}

function makeDeps(sessionId = "s-1"): DiscordCommandDeps {
  return {
    concordiaUrl: "http://127.0.0.1:11111",
    sessionsRepo: {} as DiscordCommandDeps["sessionsRepo"],
    sessionChannelsRepo: {
      findByChannelId: vi.fn(() => ({ session_id: sessionId, channel_id: "chan-1" })),
    } as unknown as DiscordCommandDeps["sessionChannelsRepo"],
    pendingQuestionsRepo: {} as DiscordCommandDeps["pendingQuestionsRepo"],
    guild: {} as DiscordCommandDeps["guild"],
    layout: {} as DiscordCommandDeps["layout"],
    log: { info: vi.fn(), warn: vi.fn() },
  };
}

describe("/end-session", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("waits for the Concordia DELETE result before reporting success", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const interaction = makeInteraction();

    await endSessionCommand.execute(interaction as never, makeDeps());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:11111/v1/sessions/s-1");
    expect(interaction.editReply).toHaveBeenCalledWith({ content: "Session end requested." });
  });

  it("reports failure instead of always showing success when Concordia DELETE fails", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "diagnostic response body" }), { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const interaction = makeInteraction();
    const deps = makeDeps();

    await endSessionCommand.execute(interaction as never, deps);

    expect(interaction.editReply).toHaveBeenCalledWith({ content: "Session end failed. Please retry." });
    expect(deps.log.warn).toHaveBeenCalledWith("end-session DELETE failed");
    expect(deps.log.warn).not.toHaveBeenCalledWith(expect.stringContaining("diagnostic response body"));
  });

  it("encodes the session id as one URL path component", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await endSessionCommand.execute(makeInteraction() as never, makeDeps("session/../other?mode=delete"));

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:11111/v1/sessions/session%2F..%2Fother%3Fmode%3Ddelete",
    );
  });

  it("does not report success for a malformed successful response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 200 })));
    const interaction = makeInteraction();

    await endSessionCommand.execute(interaction as never, makeDeps());

    expect(interaction.editReply).toHaveBeenCalledWith({ content: "Session end failed. Please retry." });
  });
});
