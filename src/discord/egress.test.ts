import type { Guild } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { makeDiscordMessageMapRepo, makeDiscordSessionChannelsRepo } from "../db/discord-repo.js";
import { makeSessionMessageDeliveryRepo } from "../db/session-message-delivery-repo.js";
import type { SessionMessagePayload } from "../shared/session-message-types.js";
import { makeTestDb } from "../../tests/helpers/db.js";
import type { DiscordConfigSnapshot } from "./config.js";
import { handleEvent, isActiveRelayTarget, isChatRelayTarget, trustedDiscordChannelId, type EgressDeps } from "./egress.js";
import type { WebhookPool } from "./webhook-pool.js";

describe("trustedDiscordChannelId", () => {
  it("accepts a matching session channel and rejects a mismatch", () => {
    expect(trustedDiscordChannelId({ explicitChannelId: "c1", sessionId: "s1", sessionChannelId: "c1", forceMeta: false })).toBe("c1");
    expect(trustedDiscordChannelId({ explicitChannelId: "c2", sessionId: "s1", sessionChannelId: "c1", forceMeta: false })).toBeNull();
  });
});

describe("isActiveRelayTarget", () => {
  it("requires an active Discord surface while allowing the teardown grace window", () => {
    expect(isActiveRelayTarget("active", "active")).toBe(true);
    expect(isActiveRelayTarget("lost", "active")).toBe(false);
    expect(isActiveRelayTarget("ended", "active", 1_784_719_990, 1_784_720_000)).toBe(true);
  });
});

describe("isChatRelayTarget", () => {
  it("requires both a session id and an active Discord surface", () => {
    expect(isChatRelayTarget("s1", "active", "active")).toBe(true);
    expect(isChatRelayTarget(null, "active", "active")).toBe(false);
  });
});

describe("handleEvent session.message relay", () => {
  it("creates a Discord post and records its delivery id", async () => {
    const { deps, webhooks, deliveryRepo, sessionId } = makeSessionMessageDeps();
    handleEvent(deps, sessionMessage(sessionId, "create", { id: 7, content: "hello" }));
    await flushEgress();

    expect(webhooks.send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      content: "hello",
      allowedMentions: { parse: [] },
    }));
    expect(deliveryRepo.findExternalId(7, "discord")).toBe("discord-1");
  });

  it("edits a previously delivered message for an update", async () => {
    const { deps, webhooks, deliveryRepo, sessionId } = makeSessionMessageDeps();
    deliveryRepo.put({ message_id: 8, platform: "discord", external_id: "discord-existing", ts: 1 });
    handleEvent(deps, sessionMessage(sessionId, "update", { id: 8, author_type: "task", content: "completed" }));
    await flushEgress();

    expect(webhooks.editForSession).toHaveBeenCalledWith(sessionId, "discord-existing", "**Task**\ncompleted");
    expect(webhooks.send).not.toHaveBeenCalled();
  });

  it("posts thinking as a quote by default and drops it with message optimization", async () => {
    const { deps, webhooks, sessionId } = makeSessionMessageDeps();
    handleEvent(deps, sessionMessage(sessionId, "create", { id: 9, author_type: "thinking", content: "private reasoning" }));
    await flushEgress();
    expect(webhooks.send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ content: "> private reasoning" }));

    const optimized = makeSessionMessageDeps({ messageOptimizationEnabled: true });
    handleEvent(optimized.deps, sessionMessage(optimized.sessionId, "create", { id: 10, author_type: "thinking", content: "hidden" }));
    await flushEgress();
    expect(optimized.webhooks.send).not.toHaveBeenCalled();
  });

  it("drops oversized attachment data before decoding it for Discord", async () => {
    const { deps, webhooks, sessionId } = makeSessionMessageDeps();
    handleEvent(deps, sessionMessage(sessionId, "create", {
      id: 11,
      content: "",
      attachments: [{ kind: "image", media_type: "image/png", data: "A".repeat(32 * 1024 * 1024 + 1) }],
    }));
    await flushEgress();

    expect(webhooks.send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ content: "(attachment)" }));
    expect(webhooks.send.mock.calls[0]?.[1]).not.toHaveProperty("files");
  });

  it("does not use transcript.frame as a Discord egress input", async () => {
    const { deps, webhooks, sessionId } = makeSessionMessageDeps();
    handleEvent(deps, { type: "transcript.frame", target_session_id: sessionId, seq: 1, kind: "text", payload: { role: "assistant", text: "legacy" }, ts: 1 });
    await flushEgress();
    expect(webhooks.send).not.toHaveBeenCalled();
  });
});

function sessionMessage(
  sessionId: string,
  op: "create" | "update",
  overrides: Partial<SessionMessagePayload>,
): Extract<import("../events.js").ConcordiaEvent, { type: "session.message" }> {
  return {
    type: "session.message",
    target_session_id: sessionId,
    op,
    ts: 100,
    message: {
      id: 1,
      session_id: sessionId,
      ts: 100,
      edited_ts: null,
      author_type: "assistant",
      author_label: "Assistant",
      author_platform: null,
      content: "message",
      embeds: null,
      components: null,
      attachments: null,
      reference_id: null,
      metadata: null,
      dedupe_key: "frame:1",
      ...overrides,
    },
  };
}

function makeSessionMessageDeps(opts: { messageOptimizationEnabled?: boolean } = {}): {
  deps: EgressDeps;
  webhooks: { getForSession: ReturnType<typeof vi.fn>; getForChannel: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; editForSession: ReturnType<typeof vi.fn> };
  deliveryRepo: ReturnType<typeof makeSessionMessageDeliveryRepo>;
  sessionId: string;
} {
  const db = makeTestDb();
  const sessionId = "s1";
  const sessionChannelsRepo = makeDiscordSessionChannelsRepo(db);
  sessionChannelsRepo.upsert({ session_id: sessionId, channel_id: "ch-session", status: "active" });
  const webhooks = {
    getForSession: vi.fn(async () => ({ id: "wh-session" })),
    getForChannel: vi.fn(),
    send: vi.fn(async () => ({ id: "discord-1" })),
    editForSession: vi.fn(async () => true),
  };
  const deps: EgressDeps = {
    guild: {} as Guild,
    layout: { metaChannels: {}, guildId: "guild" } as DiscordConfigSnapshot,
    webhooks: webhooks as unknown as WebhookPool,
    readModel: { getSessionRelayState: () => ({ sessionId, provider: "claude-code", status: "active", roleLabel: "Claude Code", model: null, currentTask: null, webhookName: null, webhookAvatarUrl: null, delegationEmoji: null }) } as never,
    sessionChannelsRepo,
    messageMap: makeDiscordMessageMapRepo(db),
    deliveryRepo: makeSessionMessageDeliveryRepo(db),
    messageOptimizationEnabled: opts.messageOptimizationEnabled,
    log: { warn: vi.fn() },
  };
  return { deps, webhooks, deliveryRepo: deps.deliveryRepo, sessionId };
}

async function flushEgress(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}
