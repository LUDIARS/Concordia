import { describe, expect, it } from "vitest";
import {
  buildForumStarterContent,
  buildForumThreadTitle,
  resolveForumSessionSurface,
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
    expect(buildForumThreadTitle("Cc", "x".repeat(200))).toHaveLength(100);
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
