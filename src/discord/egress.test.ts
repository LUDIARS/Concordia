import type { Guild } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { makeDiscordMessageMapRepo, makeDiscordSessionChannelsRepo } from "../db/discord-repo.js";
import type { ProviderName } from "../shared/types.js";
import { makeTestDb } from "../../tests/helpers/db.js";
import type { DiscordConfigSnapshot } from "./config.js";
import { handleEvent, isActiveRelayTarget, isChatRelayTarget, trustedDiscordChannelId, type EgressDeps } from "./egress.js";
import type { WebhookPool } from "./webhook-pool.js";

describe("trustedDiscordChannelId", () => {
  it("accepts the explicit channel when it matches the session channel", () => {
    expect(trustedDiscordChannelId({
      explicitChannelId: "c1",
      sessionId: "s1",
      sessionChannelId: "c1",
      forceMeta: false,
    })).toBe("c1");
  });

  it("rejects a mismatched explicit channel for session-scoped posts", () => {
    expect(trustedDiscordChannelId({
      explicitChannelId: "c2",
      sessionId: "s1",
      sessionChannelId: "c1",
      forceMeta: false,
    })).toBeNull();
  });

  it("keeps explicit routing for meta-channel posts", () => {
    expect(trustedDiscordChannelId({
      explicitChannelId: "meta1",
      sessionId: "s1",
      sessionChannelId: "c1",
      forceMeta: true,
    })).toBe("meta1");
  });

  it("rejects explicit routing when the chat has no session", () => {
    expect(trustedDiscordChannelId({
      explicitChannelId: "meta1",
      sessionId: null,
      sessionChannelId: null,
      forceMeta: true,
    })).toBeNull();
  });
});

describe("isActiveRelayTarget", () => {
  it("allows relay only when both Concordia session and Discord channel mapping are active", () => {
    expect(isActiveRelayTarget("active", "active")).toBe(true);
    expect(isActiveRelayTarget("lost", "active")).toBe(false);
    expect(isActiveRelayTarget("active", "lost")).toBe(false);
    expect(isActiveRelayTarget("ended", "active")).toBe(false);
    expect(isActiveRelayTarget("active", null)).toBe(false);
  });
});

describe("isChatRelayTarget", () => {
  it("requires both a session id and an active Discord session channel", () => {
    expect(isChatRelayTarget("s1", "active", "active")).toBe(true);
    expect(isChatRelayTarget(null, null, null)).toBe(false);
    expect(isChatRelayTarget("s1", "active", null)).toBe(false);
    expect(isChatRelayTarget("s1", "ended", "active")).toBe(false);
  });
});

describe("handleEvent transcript.frame relay", () => {
  it("relays claude-code assistant text through the session webhook", async () => {
    const { deps, webhooks, sent, sessionId } = makeTranscriptRelayDeps("claude-code");

    handleEvent(deps, {
      type: "transcript.frame",
      target_session_id: sessionId,
      seq: 1,
      kind: "text",
      payload: { role: "assistant", text: "hello from Claude" },
      ts: 100,
    });
    await flushEgress();

    expect(webhooks.getForSession).toHaveBeenCalledWith(sessionId);
    expect(webhooks.send).toHaveBeenCalledTimes(1);
    expect(sent[0].options).toMatchObject({ content: "hello from Claude" });
  });

  it("does not relay claude-code user prompts from transcript.frame", async () => {
    const { deps, webhooks, sessionId } = makeTranscriptRelayDeps("claude-code");

    handleEvent(deps, {
      type: "transcript.frame",
      target_session_id: sessionId,
      seq: 2,
      kind: "text",
      payload: { role: "user", text: "please do the thing" },
      ts: 101,
    });
    await flushEgress();

    expect(webhooks.getForSession).not.toHaveBeenCalled();
    expect(webhooks.send).not.toHaveBeenCalled();
  });

  it("skips assistant text when Discord message optimization is enabled", async () => {
    const { deps, webhooks, sessionId } = makeTranscriptRelayDeps("claude-code", {
      messageOptimizationEnabled: true,
    });

    handleEvent(deps, {
      type: "transcript.frame",
      target_session_id: sessionId,
      seq: 3,
      kind: "text",
      payload: { role: "assistant", text: "intermediate output" },
      ts: 102,
    });
    await flushEgress();

    expect(webhooks.getForSession).not.toHaveBeenCalled();
    expect(webhooks.send).not.toHaveBeenCalled();
  });

  it("still relays codex-cli assistant text when Discord message optimization is enabled", async () => {
    const { deps, webhooks, sent, sessionId } = makeTranscriptRelayDeps("codex-cli", {
      messageOptimizationEnabled: true,
    });

    handleEvent(deps, {
      type: "transcript.frame",
      target_session_id: sessionId,
      seq: 4,
      kind: "text",
      payload: { role: "assistant", text: "hello from Codex" },
      ts: 103,
    });
    await flushEgress();

    expect(webhooks.getForSession).toHaveBeenCalledWith(sessionId);
    expect(webhooks.send).toHaveBeenCalledTimes(1);
    expect(sent[0].options).toMatchObject({ content: "hello from Codex" });
  });

  it("skips codex-cli commentary when Discord message optimization is enabled", async () => {
    const { deps, webhooks, sessionId } = makeTranscriptRelayDeps("codex-cli", {
      messageOptimizationEnabled: true,
    });

    handleEvent(deps, {
      type: "transcript.frame",
      target_session_id: sessionId,
      seq: 5,
      kind: "text",
      payload: { role: "assistant", text: "working update", phase: "commentary" },
      ts: 104,
    });
    await flushEgress();

    expect(webhooks.getForSession).not.toHaveBeenCalled();
    expect(webhooks.send).not.toHaveBeenCalled();
  });

  it("relays codex-cli final_answer when Discord message optimization is enabled", async () => {
    const { deps, webhooks, sent, sessionId } = makeTranscriptRelayDeps("codex-cli", {
      messageOptimizationEnabled: true,
    });

    handleEvent(deps, {
      type: "transcript.frame",
      target_session_id: sessionId,
      seq: 6,
      kind: "text",
      payload: { role: "assistant", text: "done", phase: "final_answer" },
      ts: 105,
    });
    await flushEgress();

    expect(webhooks.getForSession).toHaveBeenCalledWith(sessionId);
    expect(webhooks.send).toHaveBeenCalledTimes(1);
    expect(sent[0].options).toMatchObject({ content: "done" });
  });

  it("still relays summaries when Discord message optimization is enabled", async () => {
    const { deps, webhooks, sent, sessionId } = makeTranscriptRelayDeps("claude-code", {
      messageOptimizationEnabled: true,
    });

    handleEvent(deps, {
      type: "transcript.frame",
      target_session_id: sessionId,
      seq: 7,
      kind: "summary",
      payload: { text: "compact summary" },
      ts: 106,
    });
    await flushEgress();

    expect(webhooks.getForSession).toHaveBeenCalledWith(sessionId);
    expect(webhooks.send).toHaveBeenCalledTimes(1);
    expect(sent[0].options).toMatchObject({ content: "compact summary", username: "Conversation summary" });
  });

  it("mirrors delegation child assistant text into the parent session channel when the child has no channel", async () => {
    const { deps, webhooks, sent, sessionId, parentSessionId } = makeTranscriptRelayDeps("codex-cli", {
      noDirectChannel: true,
      delegationParentSessionId: "parent-1",
      delegationRunId: "run-1",
    });

    handleEvent(deps, {
      type: "transcript.frame",
      target_session_id: sessionId,
      seq: 5,
      kind: "text",
      payload: { role: "assistant", text: "child update" },
      ts: 104,
    });
    await flushEgress();

    expect(webhooks.getForSession).toHaveBeenCalledWith(parentSessionId);
    expect(sent[0].options).toMatchObject({
      username: "Cc delegation",
      content: "[delegation:run-1] child s-codex-cli\n\nchild update",
    });
  });
});

function makeTranscriptRelayDeps(provider: ProviderName, opts: {
  messageOptimizationEnabled?: boolean;
  noDirectChannel?: boolean;
  delegationParentSessionId?: string;
  delegationRunId?: string;
} = {}): {
  deps: EgressDeps;
  webhooks: {
    getForSession: ReturnType<typeof vi.fn>;
    getForChannel: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
  sent: Array<{ client: unknown; options: { content?: string; username?: string } }>;
  sessionId: string;
  parentSessionId: string | null;
} {
  const db = makeTestDb();
  const sessionId = `s-${provider}`;
  const parentSessionId = opts.delegationParentSessionId ?? null;
  const sessionChannelsRepo = makeDiscordSessionChannelsRepo(db);
  if (!opts.noDirectChannel) {
    sessionChannelsRepo.upsert({
      session_id: sessionId,
      channel_id: "ch-session",
      webhook_id: "wh-session",
      webhook_token: "token",
      status: "active",
    });
  }
  if (parentSessionId) {
    sessionChannelsRepo.upsert({
      session_id: parentSessionId,
      channel_id: "ch-parent",
      webhook_id: "wh-parent",
      webhook_token: "token-parent",
      status: "active",
    });
  }
  const client = { id: "wh-session" };
  const sent: Array<{ client: unknown; options: { content?: string; username?: string } }> = [];
  const webhooks = {
    getForSession: vi.fn(async () => client),
    getForChannel: vi.fn(async () => client),
    send: vi.fn(async (c: unknown, options: { content?: string; username?: string }) => {
      sent.push({ client: c, options });
      return { id: `discord-${sent.length}` };
    }),
  };
  const deps: EgressDeps = {
    guild: {} as Guild,
    layout: {
      guildId: "guild",
      forumMode: false,
      sessionForumId: "",
      taskWorkflowForumId: "",
      metaCategoryId: "meta",
      sessionsCategoryId: "sessions",
      statusCategoryId: "status",
      archiveCategoryId: "archive",
      costChannelId: "cost",
      activityChannelId: "activity",
      monitorChannelId: "monitor",
      prQueueChannelId: "pr",
      errorCategoryId: "errors",
      errorChannelId: "error",
      metaChannels: {
        chitchat: "meta-chitchat",
        consultation: "meta-consultation",
        houkoku: "meta-houkoku",
        boyaki: "meta-boyaki",
        system: "meta-system",
      },
    } satisfies DiscordConfigSnapshot,
    webhooks: webhooks as unknown as WebhookPool,
    readModel: {
      getSessionRelayState: (requestedSessionId: string) => ({
        sessionId: requestedSessionId,
        provider,
        repoPath: "/repo",
        branch: null,
        status: "active",
        currentTask: null,
        roleLabel: requestedSessionId === parentSessionId ? "Parent" : "Claude Code",
        delegationEmoji: null,
        delegationRunId: requestedSessionId === sessionId ? opts.delegationRunId ?? null : null,
        delegationParentSessionId: requestedSessionId === sessionId ? parentSessionId : null,
        model: null,
        subsidiaryId: null,
      }),
    } as never,
    sessionChannelsRepo,
    messageMap: makeDiscordMessageMapRepo(db),
    messageOptimizationEnabled: opts.messageOptimizationEnabled,
    log: { warn: vi.fn() },
  };
  return { deps, webhooks, sent, sessionId, parentSessionId };
}

async function flushEgress(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}
