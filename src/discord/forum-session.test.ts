import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { SESSION_STATE_TAG_NAMES } from "./config.js";
import { CONCORDIA_MANAGED_FORUM_TAG_NAME } from "./forum-system-tag.js";
import {
  buildForumStarterContent,
  buildForumThreadTitle,
  createForumSessionThread,
  resolveForumSessionSurface,
  updateForumSessionState,
  updateForumSessionTitle,
} from "./forum-session.js";

describe("forum session surfaces", () => {
  it("renders delegation runs as TaskWorkflow metadata", () => {
    const content = buildForumStarterContent("guild-1", {
      sessionId: "session-1",
      repoPath: "E:/Document/Ars/Concordia",
      branch: "codex/forum-phase3",
      model: "gpt-5.6-sol",
      effortLevel: "high",
      fastMode: false,
      surfaceLabel: "TaskWorkflow",
      delegationRunId: "run-1",
    });
    expect(content).toContain("**TaskWorkflow** `session-1`");
    expect(content).toContain("**Delegation run** `run-1`");
    expect(content).toContain("**作業ブランチ** 🟠 non-root `codex/forum-phase3`");
    expect(content).toContain("model `gpt-5.6-sol` · effort `high` · fast OFF");
  });

  it("keeps forum titles within the Discord limit", () => {
    expect(buildForumThreadTitle("Cc", "x".repeat(200), "🧭")).toHaveLength(100);
  });

  it("prefixes TaskWorkflow titles with the delegation template emoji", () => {
    expect(buildForumThreadTitle("Cc", "Implement delegation", " 🧭 ")).toBe(
      "🧭 [Cc] Implement delegation",
    );
    expect(buildForumThreadTitle("Cc", "Normal session", null)).toBe("[Cc] Normal session");
  });

  it("uses the delegation emoji when creating and renaming a forum thread", async () => {
    const thread = {
      id: "thread-1",
      type: ChannelType.PublicThread,
      parent: null as any,
      setName: vi.fn(async () => undefined),
    };
    const forum = {
      id: "forum-1",
      type: ChannelType.GuildForum,
      availableTags: [
        { id: "active-tag", name: SESSION_STATE_TAG_NAMES.active },
        { id: "managed-tag", name: CONCORDIA_MANAGED_FORUM_TAG_NAME },
      ],
    };
    thread.parent = forum;
    const createForumThread = vi.fn(async () => ({
      threadId: "thread-1",
      messageId: "message-1",
      webhookId: "webhook-1",
      webhookToken: "token-1",
    }));
    const guild = {
      id: "guild-1",
      channels: { cache: new Map<string, any>([["forum-1", forum], ["thread-1", thread]]) },
    };

    const result = await createForumSessionThread(guild as any, "forum-1", { createForumThread } as any, {
      sessionId: "session-1",
      repoPath: "E:/Document/Ars/Concordia",
      branch: "fix/delegation-channel-emoji",
      projectCode: "Cc",
      summary: "Implement delegation",
      fallbackLabel: "session",
      delegationEmoji: "🧭",
      webhookName: "Branch Agent",
      webhookAvatarUrl: "https://example.test/avatar.png",
    });
    expect(createForumThread).toHaveBeenCalledWith("forum-1", expect.objectContaining({
      threadName: "🧭 [Cc] Implement delegation",
      username: "Branch Agent",
      avatarURL: "https://example.test/avatar.png",
      appliedTags: ["active-tag", "managed-tag"],
    }));
    expect(result).toEqual(expect.objectContaining({ thread, starterMessageId: "message-1" }));

    await updateForumSessionTitle(thread as any, "Cc", "Review delegation", "🧭");
    expect(thread.setName).toHaveBeenCalledWith(
      "🧭 [Cc] Review delegation",
      "Concordia session title updated",
    );
  });

  it("routes one delegation run to one TaskWorkflow forum thread", () => {
    const layout = { sessionForumId: "session-forum", taskWorkflowForumId: "task-forum" };
    expect(resolveForumSessionSurface(layout, "run-1")).toEqual({
      forumId: "task-forum",
      label: "TaskWorkflow",
      delegationRunId: "run-1",
    });
    expect(resolveForumSessionSurface(layout, null)).toEqual({
      forumId: "session-forum",
      label: "Session",
      delegationRunId: null,
    });
  });

  it.each(["ended", "lost"] as const)("archives a Forum thread when a session is %s", async (state) => {
    const thread = {
      id: "thread-closed",
      appliedTags: ["active-tag"],
      archived: false,
      parent: {
        type: ChannelType.GuildForum,
        availableTags: [{ id: "active-tag", name: SESSION_STATE_TAG_NAMES.active }],
      },
      edit: vi.fn(async () => undefined),
    };

    await updateForumSessionState(thread as any, state);

    expect(thread.edit).toHaveBeenCalledWith(expect.objectContaining({
      appliedTags: [],
      archived: true,
    }));
  });
});
