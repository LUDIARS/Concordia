import { ChannelType } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import endSessionCommand from "../src/discord/commands/end-session.js";
import { handleControlInteraction } from "../src/discord/control.js";
import { discordSnowflakeTimestampMs } from "../src/discord/interaction-diagnostics.js";

describe("discord end-session interactions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("/end-session defers before session lookup and fires DELETE after ack", async () => {
    const calls: string[] = [];
    const interaction = {
      channelId: "channel-1",
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => {
        calls.push("deferReply");
        interaction.deferred = true;
      }),
      editReply: vi.fn(async () => {
        calls.push("editReply");
      }),
      reply: vi.fn(async () => {
        calls.push("reply");
      }),
    };
    const sessionChannelsRepo = {
      findByChannelId: vi.fn(() => {
        calls.push("findByChannelId");
        return { session_id: "session-1", channel_id: "channel-1" };
      }),
    };
    const fetchMock = vi.fn(async () => {
      calls.push("fetch");
      return { ok: true, text: async () => "{\"ok\":true}" };
    });
    vi.stubGlobal("fetch", fetchMock);

    await endSessionCommand.execute(interaction as any, {
      concordiaUrl: "http://127.0.0.1:11111",
      sessionChannelsRepo,
    } as any);

    expect(calls.slice(0, 3)).toEqual(["deferReply", "findByChannelId", "editReply"]);
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11111/v1/sessions/session-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("/end-session closes its forum post instead of deleting it", async () => {
    const editThread = vi.fn(async () => undefined);
    const deleteThread = vi.fn(async () => undefined);
    const interaction = {
      channelId: "thread-1",
      channel: {
        id: "thread-1",
        type: ChannelType.PublicThread,
        parent: {
          type: ChannelType.GuildForum,
          availableTags: [{ id: "active-tag", name: "作業中" }],
        },
        appliedTags: ["active-tag"],
        archived: false,
        edit: editThread,
        delete: deleteThread,
      },
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => "{\"ok\":true}" })));

    await endSessionCommand.execute(interaction as any, {
      concordiaUrl: "http://127.0.0.1:11111",
      sessionChannelsRepo: {
        findByChannelId: () => ({ session_id: "session-1", channel_id: "thread-1" }),
      },
      log: { info: vi.fn(), warn: vi.fn() },
    } as any);

    expect(editThread).toHaveBeenCalledWith(expect.objectContaining({ archived: true }));
    expect(deleteThread).not.toHaveBeenCalled();
  });

  it("control end-session confirm defers before DELETE completes", async () => {
    const calls: string[] = [];
    let resolveFetch: (value: { ok: boolean; json: () => Promise<object> }) => void = () => {
      throw new Error("fetch promise was not created");
    };
    vi.stubGlobal("fetch", vi.fn(() => {
      calls.push("fetch");
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    }));
    const interaction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      customId: "ctrl:end-session:confirm:session-1",
      channelId: "channel-1",
      user: { id: "user-1" },
      deferUpdate: vi.fn(async () => {
        calls.push("deferUpdate");
      }),
      editReply: vi.fn(async () => {
        calls.push("editReply");
      }),
    };

    const pending = handleControlInteraction(interaction as any, {
      concordiaUrl: "http://127.0.0.1:11111",
      sessionsRepo: {} as any,
      sessionChannelsRepo: {} as any,
    });

    await Promise.resolve();
    expect(calls).toEqual(["deferUpdate", "fetch"]);
    expect(interaction.editReply).not.toHaveBeenCalled();

    resolveFetch({ ok: true, json: async () => ({ ok: true }) });
    await pending;

    expect(calls).toEqual(["deferUpdate", "fetch", "editReply"]);
    expect(interaction.editReply).toHaveBeenCalledWith({ content: "Ended session-1", components: [] });
  });

  it("decodes Discord snowflake timestamps for stale-interaction diagnostics", () => {
    expect(discordSnowflakeTimestampMs("1523473383340376204")).toBe(1_783_294_759_355);
    expect(discordSnowflakeTimestampMs("not-a-snowflake")).toBeNull();
  });
});
