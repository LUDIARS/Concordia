import { describe, expect, it, vi } from "vitest";
import {
  buildSessionStartupContextMessage,
  planStartupPosts,
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

  it("marks an empty context without sending an invalid Discord message", async () => {
    const mergeMetadata = vi.fn();
    const send = vi.fn();
    const result = await postSessionStartupContext({
      sessionId: "session-1",
      context: {
        requesterUserId: null,
        startupInjectText: null,
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
    expect(send).not.toHaveBeenCalled();
    expect(mergeMetadata).toHaveBeenCalledWith("session-1", {
      [DISCORD_STARTUP_CONTEXT_POSTED_KEY]: true,
    });
  });
});

// 指令の転記を切った部署 (総務など) でも起動者にはメンションする (2026-10-10 neco 指示)。
describe("planStartupPosts", () => {
  const base = { needsTaskPost: true, needsContextPost: true, startupTaskText: "task", startupInjectText: "policy", requesterUserId: "123456789012345678" };

  it("posts the task body and the full startup context when the transcript is on", () => {
    expect(planStartupPosts({ ...base, injectTranscript: true })).toEqual({ taskPost: true, contextPost: true, includeInject: true });
  });

  it("posts only the requester mention when the transcript is off", () => {
    expect(planStartupPosts({ ...base, injectTranscript: false })).toEqual({ taskPost: false, contextPost: true, includeInject: false });
    const message = buildSessionStartupContextMessage({
      requesterUserId: base.requesterUserId, startupInjectText: null, surfaceLabel: "Session",
      sessionChannelId: "c1", sourceGuildId: null, sourceChannelId: null,
    });
    expect(message.content).toContain("<@123456789012345678> このセッションを起動しました");
    expect(message.content).not.toContain("起動時 Inject");
    expect(message.allowedMentions.users).toEqual(["123456789012345678"]);
  });

  it("posts nothing when the transcript is off and nobody launched it from Discord", () => {
    expect(planStartupPosts({ ...base, injectTranscript: false, requesterUserId: null }).contextPost).toBe(false);
  });

  it("does not post twice once the context was posted", () => {
    expect(planStartupPosts({ ...base, injectTranscript: false, needsContextPost: false }).contextPost).toBe(false);
    expect(planStartupPosts({ ...base, injectTranscript: true, needsTaskPost: false, needsContextPost: false }))
      .toEqual({ taskPost: false, contextPost: false, includeInject: true });
  });

  it("keeps the previous rule that nothing is posted without startup text when the transcript is on", () => {
    expect(planStartupPosts({ ...base, injectTranscript: true, startupTaskText: null, startupInjectText: null }))
      .toEqual({ taskPost: false, contextPost: false, includeInject: true });
  });
});
