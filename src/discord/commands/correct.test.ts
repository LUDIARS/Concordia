import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscordCommandDeps } from "../command-port.js";
import correctCommand from "./correct.js";

function makeInteraction(correction: string, question: string | null) {
  return {
    channelId: "thread-1",
    user: { id: "user-1", username: "neco-user", globalName: "neco" },
    options: {
      getString: (name: string) => (name === "correction" ? correction : name === "question" ? question : null),
    },
    reply: vi.fn(async () => undefined),
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  };
}

function makeDeps(allowed: boolean | undefined): DiscordCommandDeps {
  return {
    concordiaUrl: "http://127.0.0.1:11111",
    sessionsRepo: {} as DiscordCommandDeps["sessionsRepo"],
    sessionChannelsRepo: {
      findByChannelId: vi.fn(() => ({ session_id: "s-1", channel_id: "thread-1" })),
    } as unknown as DiscordCommandDeps["sessionChannelsRepo"],
    pendingQuestionsRepo: {} as DiscordCommandDeps["pendingQuestionsRepo"],
    guild: {} as DiscordCommandDeps["guild"],
    layout: {} as DiscordCommandDeps["layout"],
    log: { info: vi.fn(), warn: vi.fn() },
    // 訂正の登録は起動とは別の運用権限 (session_control)。 起動の許可は常に与えて混同しないことを見る。
    isLaunchUserAllowed: () => true,
    ...(allowed === undefined ? {} : { isSessionControlUserAllowed: () => allowed }),
  };
}

describe("/co-correct", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("registers the correction against the thread's session", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ correction: { id: "corr-1" } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const interaction = makeInteraction("境界づけられた文脈で用語を揃えられる", "DDD の利点");

    await correctCommand.execute(interaction as never, makeDeps(true));

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:11111/v1/sessions/s-1/corrections");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      correction: "境界づけられた文脈で用語を揃えられる", question: "DDD の利点", author: "user-1", source: "discord",
    });
    expect(interaction.editReply).toHaveBeenCalledWith({ content: expect.stringContaining("訂正を登録しました") });
  });

  it("refuses users without session-control permission, including when permission cannot be checked", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const allowed of [false, undefined]) {
      const interaction = makeInteraction("x", null);
      await correctCommand.execute(interaction as never, makeDeps(allowed));
      expect(interaction.reply).toHaveBeenCalledWith({ content: "訂正を登録する権限がありません。", ephemeral: true });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains why a correction has nowhere to go", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "department_has_no_use_case" }), { status: 409 })));
    const interaction = makeInteraction("x", null);

    await correctCommand.execute(interaction as never, makeDeps(true));

    expect(interaction.editReply).toHaveBeenCalledWith({ content: expect.stringContaining("ユースケースが無いため") });
  });
});
