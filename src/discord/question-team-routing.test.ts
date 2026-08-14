import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelType, type Guild } from "discord.js";
import type {
  DiscordPendingQuestionsRepo,
  DiscordSessionChannelsRepo,
} from "../db/discord-repo.js";
import { postQuestion } from "./question.js";

afterEach(() => {
  vi.useRealTimers();
});

function makeHarness(input: { teamChannelExists?: boolean } = {}) {
  const teamSend = vi.fn(async (_payload: unknown) => ({ id: "msg-team" }));
  const sessionSend = vi.fn(async (_payload: unknown) => ({ id: "msg-session" }));
  const channels: Record<string, unknown> = {
    "chan-session": { id: "chan-session", type: ChannelType.GuildText, send: sessionSend },
  };
  if (input.teamChannelExists !== false) {
    channels["chan-direction"] = { id: "chan-direction", type: ChannelType.GuildText, send: teamSend };
  }
  const setDiscordMessageId = vi.fn();
  const guild = {
    channels: {
      fetch: vi.fn(async (id: string) => {
        const channel = channels[id];
        if (!channel) throw new Error(`unknown channel ${id}`);
        return channel;
      }),
    },
  } as unknown as Guild;
  const sessionChannelsRepo = {
    findBySessionId: () => ({ channel_id: "chan-session" }),
  } as unknown as DiscordSessionChannelsRepo;
  const pendingQuestionsRepo = {
    setDiscordMessageId,
  } as unknown as DiscordPendingQuestionsRepo;
  return { guild, sessionChannelsRepo, pendingQuestionsRepo, teamSend, sessionSend, setDiscordMessageId };
}

async function post(
  harness: ReturnType<typeof makeHarness>,
  resolveTeamChannelId: ((sessionId: string) => string | null) | undefined,
) {
  vi.useFakeTimers();
  const posting = postQuestion({
    guild: harness.guild,
    sessionChannelsRepo: harness.sessionChannelsRepo,
    pendingQuestionsRepo: harness.pendingQuestionsRepo,
    log: { warn: vi.fn() },
    resolveTeamChannelId,
  }, {
    target_session_id: "session-1",
    question_id: 7,
    question: "Which?",
    options: [{ label: "A" }, { label: "B" }],
  });
  await vi.runAllTimersAsync();
  await posting;
}

describe("postQuestion team surface routing", () => {
  it("posts to the team direction channel when the resolver returns one", async () => {
    const harness = makeHarness();
    await post(harness, () => "chan-direction");

    expect(harness.teamSend).toHaveBeenCalledTimes(1);
    expect(harness.sessionSend).not.toHaveBeenCalled();
    // 解決フロー (ボタン除去) が実投稿先を辿れるよう、 チーム面の channel_id を保存する。
    expect(harness.setDiscordMessageId).toHaveBeenCalledWith(7, "msg-team", "chan-direction");
  });

  it("falls back to the session channel when no team is resolved", async () => {
    const harness = makeHarness();
    await post(harness, () => null);

    expect(harness.sessionSend).toHaveBeenCalledTimes(1);
    expect(harness.teamSend).not.toHaveBeenCalled();
    expect(harness.setDiscordMessageId).toHaveBeenCalledWith(7, "msg-session", "chan-session");
  });

  it("falls back to the session channel when the team channel cannot be fetched", async () => {
    const harness = makeHarness({ teamChannelExists: false });
    await post(harness, () => "chan-direction");

    expect(harness.sessionSend).toHaveBeenCalledTimes(1);
    expect(harness.setDiscordMessageId).toHaveBeenCalledWith(7, "msg-session", "chan-session");
  });
});
