import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { SESSION_STATE_TAG_NAMES } from "./config.js";
import {
  buildForumStarterContent,
  buildForumThreadTitle,
  createForumSessionThread,
  resolveForumSessionSurface,
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
    const thread = { setName: vi.fn(async () => undefined) };
    const create = vi.fn(async () => thread);
    const forum = {
      type: ChannelType.GuildForum,
      availableTags: [{ id: "active-tag", name: SESSION_STATE_TAG_NAMES.active }],
      threads: { create },
    };
    const guild = {
      id: "guild-1",
      channels: { cache: new Map([["forum-1", forum]]) },
    };

    await createForumSessionThread(guild as any, "forum-1", {
      sessionId: "session-1",
      repoPath: "E:/Document/Ars/Concordia",
      branch: "fix/delegation-channel-emoji",
      projectCode: "Cc",
      summary: "Implement delegation",
      fallbackLabel: "session",
      delegationEmoji: "🧭",
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: "🧭 [Cc] Implement delegation",
    }));

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
});
