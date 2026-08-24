import { describe, expect, it, vi } from "vitest";
import type { SessionRow } from "../shared/types.js";
import { buildPhaseContext, startPhaseCompaction } from "./phase-compaction.js";

function activeSession(): SessionRow {
  return {
    id: "session-1",
    provider: "codex-cli",
    repo_path: "E:/repo",
    repo_origin: "LUDIARS/Concordia",
    branch: "feat/goalgo-improvements-impl",
    host: "test-host",
    started_at: 1,
    ended_at: null,
    status: "active",
    last_seen_at: 1,
    current_task: "Implement the approved plan",
    transcript_path: null,
    metadata: JSON.stringify({ plan_version: 3, plan_md_ref: "spec/tasks/example.md" }),
    ws_clients: 0,
    target_project: "Concordia",
  };
}

describe("buildPhaseContext", () => {
  it("keeps durable phase references in the machine-readable handoff", () => {
    const session = activeSession();
    const result = buildPhaseContext(session, "taskflow:plan-approved");
    expect(result).toContain('"plan_version": 3');
    expect(result).toContain("spec/tasks/example.md");
    expect(result).toContain("Implement the approved plan");
  });

  it("indexes recorded card message ids from session metadata", () => {
    const session = activeSession();
    session.metadata = JSON.stringify({
      plan_version: 3,
      discord_plan_message_id: "msg-plan-1",
      discord_question_message_id: "msg-question-1",
    });
    const result = buildPhaseContext(session, "taskflow:plan-approved");
    expect(result).toContain('"discord_plan_message_id": "msg-plan-1"');
    expect(result).toContain('"discord_question_message_id": "msg-question-1"');
  });

  it("includes answered questions and the latest handoff in the index", () => {
    const session = activeSession();
    session.metadata = JSON.stringify({
      plan_version: 3,
      last_handoff: "### 現在のタスク\n残タスク B から再開",
    });
    const result = buildPhaseContext(session, "taskflow:next-task", {
      answeredQuestions: () => [
        { question: "どの DB を使う?\n(複数行)", answer_text: "SQLite", discord_message_id: "msg-q-9" },
        { question: "命名は?", answer_text: null, discord_message_id: null },
      ],
    });
    expect(result).toContain("## Answered questions");
    expect(result).toContain("- Q: どの DB を使う? (複数行) / A: SQLite [message_id=msg-q-9]");
    expect(result).toContain("- Q: 命名は? / A: (no answer text)");
    expect(result).toContain("## Latest handoff");
    expect(result).toContain("残タスク B から再開");
  });

  it("renders empty index sections as None without card lookups", () => {
    const result = buildPhaseContext(activeSession(), "taskflow:residual-sweep");
    expect(result).toContain("## Answered questions\n\nNone");
    expect(result).toContain("## Latest handoff\n\nNone");
  });

  it("injects durable phase context without clearing the session", async () => {
    const appendEvent = vi.fn();
    const handle = startPhaseCompaction({
      sessions: { findSession: () => activeSession(), appendEvent },
      contextSources: {
        answeredQuestions: () => [{ question: "命名は?", answer_text: "kebab-case", discord_message_id: "msg-q-1" }],
      },
    });

    await handle.runOnce("session-1", "taskflow:plan-approved");

    expect(appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      session_id: "session-1",
      kind: "inject",
      payload: expect.objectContaining({
        source: "phase-compaction:taskflow:plan-approved",
        text: expect.stringContaining("kebab-case"),
      }),
    }));
    handle.stop();
  });

  it("injects the durable handoff at every phase boundary", async () => {
    const appendEvent = vi.fn();
    const handle = startPhaseCompaction({
      sessions: { findSession: () => activeSession(), appendEvent },
      contextSources: {
        answeredQuestions: () => [{ question: "命名は?", answer_text: "kebab-case", discord_message_id: "msg-q-1" }],
      },
    });

    await handle.runOnce("session-1", "taskflow:next-task");

    expect(appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      session_id: "session-1",
      kind: "inject",
      payload: expect.objectContaining({
        source: "phase-compaction:taskflow:next-task",
        text: expect.stringContaining("kebab-case"),
      }),
    }));
    handle.stop();
  });

  it("falls back to metadata-only context when an optional index source fails", async () => {
    const appendEvent = vi.fn();
    const handle = startPhaseCompaction({
      sessions: { findSession: () => activeSession(), appendEvent },
      contextSources: {
        answeredQuestions: () => { throw new Error("db unavailable"); },
      },
    });

    await expect(handle.runOnce("session-1", "taskflow:residual-sweep")).resolves.toBeUndefined();
    expect(appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        text: expect.stringContaining("## Answered questions\n\nNone"),
      }),
    }));
    handle.stop();
  });
});
