import { afterEach, expect, it, vi } from "vitest";
import type { ActionRowBuilder, ButtonBuilder, Interaction } from "discord.js";
import { createDiscordPushWarning } from "./push-warning.js";
import { registerPushWarningChannel, requestDiscordPushWarning } from "../control/push-warning-dispatch.js";
import { pushWarningText } from "../control/push-warning.js";
import type { PushWarningPrompt } from "../control/push-warning.js";

const prompt: PushWarningPrompt = { sessionId: "s", repoPath: "E:/Ars/Example", branch: "main", push: {
  remoteName: "origin", remoteUrl: "https://github.com/LUDIARS/Example.git",
  updates: [{ localRef: "refs/heads/rewrite", localSha: "a".repeat(40), remoteRef: "refs/heads/main", remoteSha: "b".repeat(40) }],
} };
const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); vi.useRealTimers(); });

function fixture() {
  const edit = vi.fn(async () => undefined);
  const send = vi.fn(async (_input: { components: ActionRowBuilder<ButtonBuilder>[] }) => ({ id: "message", edit }));
  const appendEvent = vi.fn();
  const deps = { client: { isReady: () => true, channels: { fetch: async () => ({ isTextBased: () => true, send }) } },
    bridge: { register: registerPushWarningChannel, format: pushWarningText,
      requester: () => ({ platform: "discord", userId: "123456789012345678" }) },
    sessions: { recentEvents: () => [{ kind: "inject", payload: JSON.stringify({ source: "discord:123456789012345678:222222222222222222:333333333333333333" }) }], appendEvent },
    channels: { findBySessionId: () => ({ status: "active", channel_id: "channel" }) },
    owns: () => true, isAllowed: (id: string) => id === "123456789012345678", warn: vi.fn() };
  const adapter = createDiscordPushWarning(deps as unknown as Parameters<typeof createDiscordPushWarning>[0]);
  adapter.start();
  stops.push(adapter.stop);
  const button = (id: string, messageId = "message"): Interaction => ({ isButton: () => true,
    customId: (send.mock.calls[0]?.[0]?.components[0].components[0].data as { custom_id?: string }).custom_id,
    message: { id: messageId }, channelId: "channel", guildId: "guild", user: { id, bot: false },
    reply: vi.fn(async () => undefined), deferUpdate: vi.fn(async () => undefined) } as unknown as Interaction);
  return { adapter, send, appendEvent, button };
}

it("requires the authorized requester and exact delivered message, then consumes once", async () => {
  const f = fixture();
  const answer = requestDiscordPushWarning(prompt);
  await vi.waitFor(() => expect(f.appendEvent).toHaveBeenCalled());
  await expect(requestDiscordPushWarning(prompt)).resolves.toBe("busy");
  await f.adapter.handle(f.button("987654321098765432"));
  await f.adapter.handle(f.button("123456789012345678", "other-message"));
  expect(f.appendEvent).toHaveBeenCalledTimes(1);
  await f.adapter.handle(f.button("123456789012345678"));
  await expect(answer).resolves.toBe("approved");
  await f.adapter.handle(f.button("123456789012345678"));
  expect(f.appendEvent).toHaveBeenCalledTimes(2);
});

it("expires without allowing a later button response", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const answer = requestDiscordPushWarning(prompt);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(600_000);
  await expect(answer).resolves.toBe("denied");
  await f.adapter.handle(f.button("123456789012345678"));
  expect(f.appendEvent).toHaveBeenCalledTimes(1);
});

it("stops pending approval and unregisters the unavailable bot", async () => {
  const f = fixture();
  const answer = requestDiscordPushWarning(prompt);
  f.adapter.stop();
  await expect(answer).resolves.toBe("unavailable");
  await expect(requestDiscordPushWarning(prompt)).resolves.toBe("unavailable");
});
