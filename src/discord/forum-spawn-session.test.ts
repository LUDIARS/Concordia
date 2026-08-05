import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { SESSION_STATE_TAG_NAMES } from "./config.js";
import { bindForumSpawnSession } from "./forum-spawn-session.js";

function makeFixture() {
  const starterEdit = vi.fn();
  const fetchStarterMessage = vi.fn(async () => ({
    content: "User-authored task",
    edit: starterEdit,
  }));
  const thread: any = {
    id: "thread-1",
    parentId: "forum-1",
    type: ChannelType.PublicThread,
    archived: false,
    appliedTags: [],
    fetchStarterMessage,
    edit: vi.fn(async (patch: { appliedTags?: string[] }) => {
      if (patch.appliedTags) thread.appliedTags = patch.appliedTags;
      return thread;
    }),
  };
  const forum: any = {
    id: "forum-1",
    type: ChannelType.GuildForum,
    availableTags: [{ id: "active-tag", name: SESSION_STATE_TAG_NAMES.active }],
  };
  thread.parent = forum;
  const channels = new Map<string, any>([
    [thread.id, thread],
    [forum.id, forum],
  ]);
  const guild = {
    id: "guild-1",
    channels: {
      cache: channels,
      fetch: vi.fn(async (id: string) => channels.get(id) ?? null),
    },
  };
  const rows = new Map<string, any>();
  const repo = {
    findBySessionId: vi.fn((id: string) => rows.get(id) ?? null),
    upsert: vi.fn((row: any) => rows.set(row.session_id, { ...row })),
    setWebhook: vi.fn((sessionId: string, webhookId: string, webhookToken: string) => {
      Object.assign(rows.get(sessionId), {
        webhook_id: webhookId,
        webhook_token: webhookToken,
      });
    }),
  };
  const createForumSessionSurface = vi.fn(async () => ({
    messageId: "status-message-1",
    webhookId: "webhook-1",
    webhookToken: "token-1",
  }));
  const webhooks = { createForumSessionSurface };
  const log = { info: vi.fn() };
  return {
    guild,
    repo,
    webhooks,
    log,
    rows,
    thread,
    fetchStarterMessage,
    starterEdit,
    createForumSessionSurface,
  };
}

describe("bindForumSpawnSession", () => {
  it("leaves the user starter untouched and stores a separate webhook surface", async () => {
    const fixture = makeFixture();
    await bindForumSpawnSession({
      guild: fixture.guild as any,
      sessionForumId: "forum-1",
      repo: fixture.repo as any,
      webhooks: fixture.webhooks as any,
      log: fixture.log,
    }, {
      sessionId: "session-1",
      threadId: "thread-1",
      provider: "claude",
      repoPath: "E:/Document/Ars/Concordia",
      branch: "fix/forum-surface",
      callName: "impl-from-design",
      state: {
        sessionId: "session-1",
        provider: "claude",
        repoPath: "E:/Document/Ars/Concordia",
        activeRepos: [],
        branch: "fix/forum-surface",
        status: "active",
        currentTask: "Fix the forum surface",
        roleLabel: "worker",
        delegationEmoji: "👩‍💻",
        delegationRunId: "run-1",
        delegationParentSessionId: null,
        model: "claude-fable-5",
        effortLevel: "xhigh",
        fastMode: false,
        subsidiaryId: null,
        endedAt: null,
      },
    });

    expect(fixture.fetchStarterMessage).not.toHaveBeenCalled();
    expect(fixture.starterEdit).not.toHaveBeenCalled();
    expect(fixture.createForumSessionSurface).toHaveBeenCalledWith(
      "forum-1",
      "thread-1",
      expect.objectContaining({
        username: "Fable 5 · impl-from-design",
        avatarURL: expect.stringContaining("/1f469-200d-1f4bb.png"),
        allowedMentions: { parse: [] },
      }),
    );
    expect(fixture.rows.get("session-1")).toEqual(expect.objectContaining({
      channel_id: "thread-1",
      surface_message_id: "status-message-1",
      webhook_id: "webhook-1",
      webhook_token: "token-1",
    }));
  });

  it("does not post another surface for an already-bound session", async () => {
    const fixture = makeFixture();
    fixture.rows.set("session-1", {
      session_id: "session-1",
      channel_id: "thread-1",
      surface_message_id: "status-message-1",
      webhook_id: "webhook-1",
      webhook_token: "token-1",
    });
    await expect(bindForumSpawnSession({
      guild: fixture.guild as any,
      sessionForumId: "forum-1",
      repo: fixture.repo as any,
      webhooks: fixture.webhooks as any,
      log: fixture.log,
    }, {
      sessionId: "session-1",
      threadId: "thread-1",
      provider: "claude",
      repoPath: "repo",
      branch: null,
      callName: null,
      state: null,
    })).resolves.toBe("existing");
    expect(fixture.createForumSessionSurface).not.toHaveBeenCalled();
  });

  it("repairs a legacy binding that has no webhook-owned surface", async () => {
    const fixture = makeFixture();
    fixture.rows.set("session-1", {
      session_id: "session-1",
      channel_id: "thread-1",
      surface_message_id: null,
      webhook_id: null,
      webhook_token: null,
    });
    await expect(bindForumSpawnSession({
      guild: fixture.guild as any,
      sessionForumId: "forum-1",
      repo: fixture.repo as any,
      webhooks: fixture.webhooks as any,
      log: fixture.log,
    }, {
      sessionId: "session-1",
      threadId: "thread-1",
      provider: "claude",
      repoPath: "repo",
      branch: null,
      callName: "impl-from-design",
      state: null,
    })).resolves.toBe("created");

    expect(fixture.fetchStarterMessage).not.toHaveBeenCalled();
    expect(fixture.createForumSessionSurface).toHaveBeenCalledTimes(1);
    expect(fixture.rows.get("session-1")).toEqual(expect.objectContaining({
      surface_message_id: "status-message-1",
      webhook_id: "webhook-1",
      webhook_token: "token-1",
    }));
  });
});
