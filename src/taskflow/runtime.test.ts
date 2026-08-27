import { describe, expect, it, vi } from "vitest";
import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { SessionRow } from "../shared/types.js";
import { makeTestDb } from "../../tests/helpers/db.js";
import { TaskflowRuntime, type TaskflowRuntimeDeps } from "./runtime.js";

function session(id: string): SessionRow {
  return {
    id,
    provider: "codex-cli",
    repo_path: "repo",
    repo_origin: "owner/repo",
    branch: "feature/task",
    host: "host",
    started_at: 1,
    ended_at: null,
    status: "active",
    last_seen_at: 1,
    current_task: "task",
    transcript_path: null,
    metadata: "{}",
    ws_clients: 1,
    target_project: null,
  };
}

function runtimeFor(row: SessionRow) {
  const db = makeTestDb();
  const appendEvent = vi.fn();
  const sessions = {
    findSession: vi.fn(() => row),
    appendEvent,
    mergeMetadata: vi.fn((_id: string, patch: Record<string, unknown>) => {
      row.metadata = JSON.stringify({ ...JSON.parse(row.metadata ?? "{}") as Record<string, unknown>, ...patch });
    }),
  };
  const runtime = new TaskflowRuntime({
    db,
    sessions,
    delegation: {},
    prs: { list: vi.fn(() => [{ state: "open" }]) },
    store: {
      findForProject: vi.fn(async (_path: string, statuses: string[]) => statuses.includes("delegated") ? [{}] : []),
    },
    confirm: {},
    mentionUserId: () => null,
  } as unknown as TaskflowRuntimeDeps);
  return { appendEvent, runtime };
}

describe("TaskflowRuntime.handleCompletedRun", () => {
  it("schedules teardown for the delegation child session", async () => {
    const row = session("child-session");
    const { appendEvent, runtime } = runtimeFor(row);
    await runtime.handleCompletedRun({
      id: "run-1",
      parent_session_id: "parent-session",
      child_session_id: row.id,
    } as DelegationRunRow);

    expect(appendEvent).toHaveBeenCalledOnce();
    expect(JSON.parse(row.metadata ?? "{}")).toMatchObject({
      teardown_ladder: { run_key: "delegation:run-1" },
    });
  });

  it("does not schedule teardown on the parent when the run has no child session", async () => {
    const row = session("parent-session");
    const { appendEvent, runtime } = runtimeFor(row);
    await runtime.handleCompletedRun({
      id: "run-1",
      parent_session_id: row.id,
      child_session_id: null,
    } as DelegationRunRow);

    expect(appendEvent).not.toHaveBeenCalled();
    expect(JSON.parse(row.metadata ?? "{}")).not.toHaveProperty("teardown_ladder");
  });
});
