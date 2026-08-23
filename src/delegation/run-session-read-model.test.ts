import { describe, expect, it, vi } from "vitest";
import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { SessionRow } from "../shared/types.js";
import { DelegationRunSessionReadModel } from "./run-session-read-model.js";

describe("DelegationRunSessionReadModel", () => {
  it("parses each session once even when many runs are resolved", () => {
    const sessions = Array.from({ length: 1_000 }, (_, index) => session({
      id: `session-${index}`,
      started_at: 1_000 + index,
      metadata: JSON.stringify({ delegation_call_name: "impl" }),
    }));
    const parseMetadata = vi.fn((row: SessionRow) => JSON.parse(row.metadata ?? "{}") as Record<string, unknown>);
    const readModel = new DelegationRunSessionReadModel(sessions, parseMetadata);

    for (let index = 0; index < 500; index += 1) {
      readModel.linkedSessions(run({ id: `run-${index}`, created_at: 1_500_000 }), { cwd: "C:/repo" });
    }

    expect(parseMetadata).toHaveBeenCalledTimes(sessions.length);
  });

  it("links explicit ids and only legacy sessions in the matching repo and time window", () => {
    const readModel = new DelegationRunSessionReadModel([
      session({ id: "child", repo_path: "C:/elsewhere", metadata: null }),
      session({ id: "by-run", metadata: JSON.stringify({ delegation_run_id: "run-1" }) }),
      session({ id: "legacy", started_at: 1_500, metadata: JSON.stringify({ delegation_call_name: "impl" }) }),
      session({ id: "wrong-run", metadata: JSON.stringify({ delegation_run_id: "run-2", delegation_call_name: "impl" }) }),
      session({ id: "wrong-repo", repo_path: "C:/other", metadata: JSON.stringify({ delegation_call_name: "impl" }) }),
      session({ id: "too-late", started_at: 2_101, metadata: JSON.stringify({ delegation_call_name: "impl" }) }),
    ]);

    const linked = readModel.linkedSessions(run({ child_session_id: "child", created_at: 1_500_000 }), {
      cwd: "C:/repo",
    });

    expect(linked.map((row) => row.id)).toEqual(["legacy", "child", "by-run"]);
  });

  it("ignores malformed and non-object metadata", () => {
    const readModel = new DelegationRunSessionReadModel([
      session({ id: "malformed", metadata: "not-json" }),
      session({ id: "null", metadata: "null" }),
      session({ id: "array", metadata: "[]" }),
    ]);

    expect(readModel.linkedSessions(run(), { cwd: "C:/repo" })).toEqual([]);
  });
});

function run(overrides: Partial<DelegationRunRow> = {}): DelegationRunRow {
  return {
    id: "run-1",
    call_name: "impl",
    child_session_id: null,
    created_at: 1_000_000,
    ...overrides,
  } as DelegationRunRow;
}

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session",
    provider: "codex-cli",
    repo_path: "C:/repo/worktree",
    repo_origin: null,
    branch: "feat/test",
    host: "test",
    started_at: 1_000,
    ended_at: null,
    status: "active",
    last_seen_at: 1_000,
    current_task: null,
    transcript_path: null,
    metadata: null,
    ws_clients: 0,
    target_project: null,
    ...overrides,
  };
}
