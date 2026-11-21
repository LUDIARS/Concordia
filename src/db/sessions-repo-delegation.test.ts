import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionsRepo } from "./sessions-repo.js";
import { DelegationRunSessionReadModel, legacyLinkTargetRepo } from "../delegation/run-session-read-model.js";
import type { DelegationRunRow } from "./delegation-repo.js";

describe("SessionsRepo.listDelegationSessionsForRun", () => {
  it("returns only the exact and bounded legacy candidates", () => {
    const repo = new SessionsRepo(makeTestDb());
    insert(repo, "child", 1_200, null);
    insert(repo, "by-run", 1_100, { delegation_run_id: "run-1" });
    insert(repo, "by-trimmed-run", 1_101, { delegation_run_id: " run-1 " });
    insert(repo, "legacy", 1_500, { delegation_call_name: "impl" });
    insert(repo, "legacy-trimmed", 1_499, { delegation_call_name: " impl " });
    insert(repo, "legacy-blank-run", 1_498, { delegation_run_id: " ", delegation_call_name: "impl" });
    insert(repo, "legacy-non-string-run", 1_497, { delegation_run_id: [], delegation_call_name: "impl" });
    insert(repo, "wrong-run", 1_500, { delegation_run_id: "run-2", delegation_call_name: "impl" });
    insert(repo, "wrong-call", 1_500, { delegation_call_name: "review" });
    insert(repo, "too-early", 900, { delegation_call_name: "impl" });
    insert(repo, "too-late", 2_101, { delegation_call_name: "impl" });
    insert(repo, "malformed", 1_500, "not-json");
    insert(repo, "non-object", 1_500, "null");

    const rows = repo.listDelegationSessionsForRun({
      runId: "run-1",
      childSessionId: "child",
      callName: "impl",
      createdAtMs: 1_500_999,
    });

    expect(rows.map((row) => row.id)).toEqual([
      "legacy",
      "legacy-trimmed",
      "legacy-blank-run",
      "legacy-non-string-run",
      "child",
      "by-trimmed-run",
      "by-run",
    ]);
  });
});

describe("SessionsRepo.listDelegationSessionsForRuns", () => {
  it("links the same sessions as a read model built over every session", () => {
    const repo = new SessionsRepo(makeTestDb());
    insert(repo, "child", 1_200, null);
    insert(repo, "by-run", 1_100, { delegation_run_id: "run-1" });
    insert(repo, "by-run-2", 3_000, { delegation_run_id: " run-2 " });
    insert(repo, "legacy", 1_500, { delegation_call_name: "impl" });
    insert(repo, "legacy-other-window", 5_000, { delegation_call_name: "impl" });
    insert(repo, "legacy-non-string-run", 1_497, { delegation_run_id: [], delegation_call_name: "impl" });
    insert(repo, "wrong-call", 1_500, { delegation_call_name: "review" });
    insert(repo, "too-late", 2_101, { delegation_call_name: "impl" });
    insert(repo, "malformed", 1_500, "{not json");
    insert(repo, "unrelated", 1_500, { other: true });

    const runs = [
      run("run-1", "child", "impl", 1_500_999, { target_repo: "C:/repo" }),
      run("run-2", null, "impl", 5_000_000, { repo_path: "C:/repo/worktree" }),
      run("run-3", null, "impl", 1_500_000, {}),
    ];
    const args = (row: DelegationRunRow) => JSON.parse(row.args_json) as Record<string, unknown>;
    const candidates = repo.listDelegationSessionsForRuns(runs.map((row) => ({
      id: row.id,
      child_session_id: row.child_session_id,
      call_name: row.call_name,
      created_at: row.created_at,
      usesLegacyLink: legacyLinkTargetRepo(args(row)) !== null,
    })));
    const everySession = repo.listSessions({ limit: 500 });
    const fromCandidates = new DelegationRunSessionReadModel(candidates);
    const fromEverySession = new DelegationRunSessionReadModel(everySession);
    for (const row of runs) {
      expect(fromCandidates.linkedSessions(row, args(row)).map((s) => s.id))
        .toEqual(fromEverySession.linkedSessions(row, args(row)).map((s) => s.id));
    }
    expect(candidates.map((row) => row.id)).not.toContain("unrelated");
    expect(candidates.map((row) => row.id)).not.toContain("malformed");
  });

  it("returns nothing for an empty run list", () => {
    expect(new SessionsRepo(makeTestDb()).listDelegationSessionsForRuns([])).toEqual([]);
  });
});

function run(id: string, child: string | null, callName: string, createdAt: number, args: object): DelegationRunRow {
  return {
    id,
    child_session_id: child,
    call_name: callName,
    created_at: createdAt,
    args_json: JSON.stringify(args),
  } as unknown as DelegationRunRow;
}

function insert(repo: SessionsRepo, id: string, startedAt: number, metadata: object | string | null): void {
  repo.insertSession({
    id,
    provider: "codex-cli",
    repo_path: "C:/repo/worktree",
    repo_origin: null,
    branch: "feat/test",
    host: "test",
    started_at: startedAt,
    last_seen_at: startedAt,
    transcript_path: null,
    metadata: typeof metadata === "string" ? metadata : metadata ? JSON.stringify(metadata) : null,
  });
}
