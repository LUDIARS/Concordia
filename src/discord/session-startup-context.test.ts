import { describe, expect, it, vi } from "vitest";
import {
  buildSessionStartupContextMessage,
  DISCORD_STARTUP_CONTEXT_POSTED_KEY,
  postSessionStartupContext,
} from "./session-startup-context.js";

describe("session startup context", () => {
  it("mentions only the requester and links TaskWorkflow to both surfaces", () => {
    const message = buildSessionStartupContextMessage({
      requesterUserId: "123456789",
      startupInjectText: "Cc の修正を開始する",
      surfaceLabel: "TaskWorkflow",
      sessionChannelId: "222222222",
      sourceGuildId: "111111111",
      sourceChannelId: "333333333",
    });
    expect(message.content).toContain("<@123456789>");
    expect(message.content).toContain("**起動セッション** <#222222222>");
    expect(message.content).toContain(
      "https://discord.com/channels/111111111/333333333",
    );
    expect(message.content).toContain("**起動時 Inject**\n\nCc の修正を開始する");
    expect(message.allowedMentions).toEqual({ parse: [], users: ["123456789"] });
  });

  it("marks the startup context only after a successful send", async () => {
    const mergeMetadata = vi.fn();
    const send = vi.fn(async () => ({ id: "message-1" }));
    const result = await postSessionStartupContext({
      sessionId: "session-1",
      context: {
        requesterUserId: null,
        startupInjectText: "work policy",
        surfaceLabel: "Session",
        sessionChannelId: "222222222",
        sourceGuildId: null,
        sourceChannelId: null,
      },
      webhooks: {
        getForSession: vi.fn(async () => ({}) as never),
        send,
      },
      sessionsRepo: { mergeMetadata },
    });
    expect(result).toBe(true);
    expect(mergeMetadata).toHaveBeenCalledWith("session-1", {
      [DISCORD_STARTUP_CONTEXT_POSTED_KEY]: true,
    });
  });
});
