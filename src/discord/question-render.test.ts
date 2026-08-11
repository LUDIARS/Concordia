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

function renderHarness() {
  const send = vi.fn(async (_payload: unknown) => ({ id: "message-1" }));
  const setDiscordMessageId = vi.fn();
  const guild = {
    channels: {
      fetch: vi.fn(async () => ({
        id: "channel-1",
        type: ChannelType.GuildText,
        send,
      })),
    },
  } as unknown as Guild;
  const sessionChannelsRepo = {
    findBySessionId: () => ({ channel_id: "channel-1" }),
  } as unknown as DiscordSessionChannelsRepo;
  const pendingQuestionsRepo = {
    setDiscordMessageId,
  } as unknown as DiscordPendingQuestionsRepo;
  return { guild, sessionChannelsRepo, pendingQuestionsRepo, send, setDiscordMessageId };
}

async function renderQuestion(
  options: Array<{ label: string; description?: string }>,
  multiSelect = false,
) {
  vi.useFakeTimers();
  const harness = renderHarness();
  const posting = postQuestion({
    guild: harness.guild,
    sessionChannelsRepo: harness.sessionChannelsRepo,
    pendingQuestionsRepo: harness.pendingQuestionsRepo,
    log: { warn: vi.fn() },
  }, {
    target_session_id: "session-1",
    question_id: 42,
    question: "Which?",
    options,
    multi_select: multiSelect,
  });
  await vi.runAllTimersAsync();
  await posting;
  return harness;
}

describe("postQuestion option codes", () => {
  it("renders codes in embed fields and single-select buttons", async () => {
    const { send } = await renderQuestion([
      { label: "First", description: "one" },
      { label: "Second" },
    ]);
    const payload = send.mock.calls[0]![0] as {
      embeds: Array<{ toJSON(): { fields?: Array<{ name: string }> } }>;
      components: Array<{ toJSON(): { components?: Array<{ label?: string }> } }>;
    };

    expect(payload.embeds[0]!.toJSON().fields?.map((field) => field.name))
      .toEqual(["[A] First", "[B] Second"]);
    expect(payload.components[0]!.toJSON().components?.map((button) => button.label))
      .toEqual(["[A] First", "[B] Second"]);
  });

  it("renders codes in multi-select menu options", async () => {
    const { send } = await renderQuestion([{ label: "First" }, { label: "Second" }], true);
    const payload = send.mock.calls[0]![0] as {
      components: Array<{
        toJSON(): { components?: Array<{ options?: Array<{ label: string }> }> };
      }>;
    };

    expect(payload.components[0]!.toJSON().components?.[0]?.options?.map((option) => option.label))
      .toEqual(["[A] First", "[B] Second"]);
  });
});
