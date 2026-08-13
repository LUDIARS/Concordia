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

  it("compacts at the phase threshold using the injected context estimate", async () => {
    const compact = vi.fn(async () => ({ ok: true }));
    const appendEvent = vi.fn();
    const handle = startPhaseCompaction({
      sessions: { findSession: () => activeSession(), appendEvent },
      compact,
      estimateContextPct: async () => 0.35,
      threshold: 0.35,
    });

    await handle.runOnce("session-1", "taskflow:plan-approved");

    expect(compact).toHaveBeenCalledWith("session-1");
    expect(appendEvent).not.toHaveBeenCalled();
    handle.stop();
  });

  it("injects the durable handoff below the phase threshold", async () => {
    const compact = vi.fn(async () => ({ ok: true }));
    const appendEvent = vi.fn();
    const handle = startPhaseCompaction({
      sessions: { findSession: () => activeSession(), appendEvent },
      compact,
      estimateContextPct: async () => 0.34,
      threshold: 0.35,
    });

    await handle.runOnce("session-1", "taskflow:next-task");

    expect(compact).not.toHaveBeenCalled();
    expect(appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      session_id: "session-1",
      kind: "inject",
      payload: expect.objectContaining({ source: "phase-compaction:taskflow:next-task" }),
    }));
    handle.stop();
  });
});
